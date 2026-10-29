import { createHash } from 'node:crypto'

import * as Sqlite from '@effect/sql-sqlite-node'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'

import { transitionAgentRun } from '@/core/domain/execution/lifecycle.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import {
  executeSqliteScript,
  runSqliteMigrations,
  UnsupportedLedgerSchemaVersion,
} from '@/infrastructure/sqlite/sqlite-migrations.js'
import type { AgentDriverEvent, AgentRun, AgentRunStatus } from '@/shared/schemas/execution.js'
import { agentRunSchema } from '@/shared/schemas/execution.js'
import { projectIdSchema, taskIdSchema, workspaceCheckoutSchema } from '@/shared/schemas/workspace.js'
import {
  type BeginRunCommand,
  beginRunCommandSchema,
  type CommandReceipt,
  commandReceiptSchema,
  createTaskCommandSchema,
  type DispatchClaim,
  dispatchFailureCommandSchema,
  enqueueFollowUpCommandSchema,
  followUpReceiptSchema,
  queuedFollowUpSchema,
  recordDriverEventCommandSchema,
  recordRequestResponseCommandSchema,
  recordSteerCommandSchema,
  registerProjectCommandSchema,
  requestResponseHistoryItemSchema,
  requestResponseIntentSchema,
  type SettleDeliveryCommand,
  settleDeliveryCommandSchema,
  steerHistoryItemSchema,
  steerIntentSchema,
  workerEpochSchema,
  WORKSPACE_STORE_COMMAND_BYTE_CAPACITY,
  type WorkspaceDeliveryOutcome,
  type WorkspaceExecutionEvent,
  workspaceExecutionEventSchema,
  type WorkspaceReadPageOptions,
  workspaceReadPageOptionsSchema,
  WorkspaceStoreError,
} from '@/shared/schemas/workspace-store.js'

const migrations = [
  {
    version: 1,
    name: 'workspace_operational_state',
    up: executeSqliteScript(`
      CREATE TABLE workspace_project (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE workspace_checkout (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES workspace_project(id), payload TEXT NOT NULL);
      CREATE TABLE workspace_task (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES workspace_project(id), archived INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL);
      CREATE TABLE workspace_conversation (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES workspace_task(id), payload TEXT NOT NULL);
      CREATE TABLE workspace_agent_session (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES workspace_task(id), conversation_id TEXT NOT NULL REFERENCES workspace_conversation(id), checkout_id TEXT NOT NULL REFERENCES workspace_checkout(id), generation INTEGER NOT NULL, driver_id TEXT NOT NULL, connection_id TEXT NOT NULL, native_session_id TEXT, status TEXT NOT NULL);
      CREATE UNIQUE INDEX workspace_native_identity ON workspace_agent_session(native_session_id) WHERE native_session_id IS NOT NULL;
      CREATE TABLE workspace_agent_run (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES workspace_task(id), session_id TEXT REFERENCES workspace_agent_session(id), checkout_id TEXT NOT NULL REFERENCES workspace_checkout(id), generation INTEGER NOT NULL, status TEXT NOT NULL, submitted_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE workspace_message (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES workspace_agent_run(id), conversation_id TEXT NOT NULL REFERENCES workspace_conversation(id), role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE workspace_dispatch_intent (run_id TEXT PRIMARY KEY REFERENCES workspace_agent_run(id), task_id TEXT NOT NULL, provisional_session_id TEXT NOT NULL, conversation_id TEXT NOT NULL, driver_id TEXT NOT NULL, connection_id TEXT NOT NULL, checkout_id TEXT NOT NULL, generation INTEGER NOT NULL, prompt TEXT NOT NULL, model_id TEXT, mode_id TEXT, requested_native_session_id TEXT, state TEXT NOT NULL, owner_epoch INTEGER, native_session_id TEXT, native_turn_id TEXT);
      CREATE TABLE workspace_command_receipt (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE workspace_execution_event (sequence INTEGER PRIMARY KEY AUTOINCREMENT, schema_version INTEGER NOT NULL, kind TEXT NOT NULL, run_id TEXT NOT NULL, task_id TEXT NOT NULL, generation INTEGER NOT NULL, occurred_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX workspace_event_run_sequence ON workspace_execution_event(run_id, sequence);
    `),
  },
  {
    version: 2,
    name: 'scope_native_session_identity_to_connection',
    up: executeSqliteScript(`
      DROP INDEX IF EXISTS workspace_native_identity;
      CREATE UNIQUE INDEX workspace_native_identity ON workspace_agent_session(driver_id, connection_id, native_session_id) WHERE native_session_id IS NOT NULL;
    `),
  },
  {
    version: 3,
    name: 'persist_retired_worker_epoch',
    up: executeSqliteScript(`
      CREATE TABLE workspace_worker_epoch (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), retired_epoch INTEGER NOT NULL CHECK (retired_epoch >= 0));
      INSERT INTO workspace_worker_epoch (singleton, retired_epoch) VALUES (1, 0);
    `),
  },
  {
    version: 4,
    name: 'persist_driver_event_identity',
    up: executeSqliteScript(`
      CREATE TABLE workspace_driver_event_identity (
        run_id TEXT NOT NULL REFERENCES workspace_agent_run(id),
        event_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        sequence INTEGER NOT NULL UNIQUE REFERENCES workspace_execution_event(sequence),
        PRIMARY KEY (run_id, event_id)
      );
    `),
  },
  {
    version: 5,
    name: 'project_driver_request_state',
    up: executeSqliteScript(`
      CREATE TABLE workspace_driver_request_state (
        run_id TEXT NOT NULL REFERENCES workspace_agent_run(id),
        request_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending', 'resolved', 'expired')),
        PRIMARY KEY (run_id, request_id)
      );
      CREATE INDEX workspace_driver_request_state_by_run ON workspace_driver_request_state(run_id, state);
      WITH request_events AS (
        SELECT run_id, sequence,
          CASE
            WHEN json_extract(payload, '$.event.kind') = 'requestPending'
              THEN json_extract(payload, '$.event.request.requestId')
            ELSE json_extract(payload, '$.event.requestId')
          END AS request_id,
          json_extract(payload, '$.event.kind') AS event_kind
        FROM workspace_execution_event
        WHERE kind = 'driverEvent'
          AND json_extract(payload, '$.event.kind') IN ('requestPending', 'requestResolved')
      ), pending_requests AS (
        SELECT run_id, request_id, MIN(sequence) AS pending_sequence
        FROM request_events
        WHERE event_kind = 'requestPending' AND request_id IS NOT NULL
        GROUP BY run_id, request_id
      )
      INSERT INTO workspace_driver_request_state (run_id, request_id, state)
      SELECT pending.run_id, pending.request_id,
        CASE
          WHEN EXISTS (
            SELECT 1 FROM request_events resolved
            WHERE resolved.run_id = pending.run_id AND resolved.request_id = pending.request_id
              AND resolved.event_kind = 'requestResolved' AND resolved.sequence > pending.pending_sequence
          ) THEN 'resolved'
          WHEN EXISTS (
            SELECT 1 FROM workspace_execution_event terminal
            WHERE terminal.run_id = pending.run_id AND terminal.kind = 'driverEvent'
              AND terminal.sequence > pending.pending_sequence
              AND json_extract(terminal.payload, '$.event.kind') IN ('turnCompleted', 'turnInterrupted', 'turnFailed')
          ) THEN 'expired'
          ELSE 'pending'
        END
      FROM pending_requests pending;
    `),
  },
  {
    version: 6,
    name: 'durable_workspace_delivery_and_follow_up',
    up: executeSqliteScript(`
      CREATE TABLE workspace_request_response_intent (
        run_id TEXT NOT NULL REFERENCES workspace_agent_run(id),
        request_id TEXT NOT NULL,
        state TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (run_id, request_id)
      );
      CREATE INDEX workspace_response_by_state ON workspace_request_response_intent(run_id, state);
      CREATE TABLE workspace_steer_intent (
        command_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workspace_agent_run(id),
        state TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX workspace_steer_by_run ON workspace_steer_intent(run_id, state);
      CREATE TABLE workspace_follow_up_queue (
        position INTEGER PRIMARY KEY AUTOINCREMENT,
        command_id TEXT NOT NULL UNIQUE,
        task_id TEXT NOT NULL REFERENCES workspace_task(id),
        conversation_id TEXT NOT NULL REFERENCES workspace_conversation(id),
        payload TEXT NOT NULL
      );
      CREATE INDEX workspace_queue_by_conversation ON workspace_follow_up_queue(conversation_id, position);
    `),
  },
] as const

const safeError = (code: ConstructorParameters<typeof WorkspaceStoreError>[0]['code'], message: string) =>
  new WorkspaceStoreError({ code, message })

const timestampSchema = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/),
)

const encode = (value: unknown): string => JSON.stringify(value)

const decodeJson =
  <A>(schema: Schema.Schema<A>) =>
  (json: string) =>
    Effect.try({
      try: () => JSON.parse(json) as unknown,
      catch: () => undefined,
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.mapError(() => safeError('invalid-data', 'Stored workspace data failed validation')),
    )

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

const fingerprint = (value: unknown): string => {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

const decodeRun = decodeJson(agentRunSchema)
const decodeWorkerEpoch = (epoch: unknown) =>
  Schema.decodeUnknownEffect(workerEpochSchema)(epoch).pipe(
    Effect.mapError(() => safeError('invalid-data', 'Worker epoch must be a positive integer')),
  )

function appendEvent(
  run: AgentRun,
  kind: WorkspaceExecutionEvent['kind'],
  occurredAt: string,
  data: Readonly<Record<string, unknown>> = {},
) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`
      INSERT INTO workspace_execution_event (schema_version, kind, run_id, task_id, generation, occurred_at, payload)
      VALUES (1, ${kind}, ${run.id}, ${run.taskId}, ${run.generation}, ${occurredAt}, ${encode(data)})
      RETURNING sequence
    `
    return Number(rows[0]?.sequence)
  })
}

function persistRun(run: AgentRun) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE workspace_agent_run SET status = ${run.status}, payload = ${encode(run)} WHERE id = ${run.id}`
  })
}

function transition(
  run: AgentRun,
  status: AgentRunStatus,
  at: string,
  details: Parameters<typeof transitionAgentRun>[3] = {},
) {
  const result = transitionAgentRun(run, status, at, details)
  return result.ok
    ? Effect.succeed(result.run)
    : Effect.fail(safeError('invalid-transition', 'Run transition is not allowed'))
}

const makeService = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql.unsafe('PRAGMA foreign_keys = ON')
  yield* sql.unsafe('PRAGMA journal_mode = WAL')
  yield* sql.unsafe('PRAGMA synchronous = FULL')
  yield* runSqliteMigrations(migrations).pipe(
    Effect.mapError(error =>
      error instanceof UnsupportedLedgerSchemaVersion
        ? safeError('invalid-data', 'Workspace database schema is newer than this application supports')
        : error,
    ),
  )
  const guard = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, WorkspaceStoreError> =>
    Effect.provideService(effect, SqlClient.SqlClient, sql).pipe(
      Effect.mapError(error =>
        error instanceof WorkspaceStoreError
          ? error
          : safeError('database-unavailable', 'Workspace database operation failed'),
      ),
    ) as Effect.Effect<A, WorkspaceStoreError>

  const registerProject = (command: Parameters<WorkspaceStore['Service']['registerProject']>[0]) =>
    guard(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(registerProjectCommandSchema)(command).pipe(
          Effect.mapError(() => safeError('invalid-data', 'Project registration data is invalid')),
        )
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`INSERT INTO workspace_project (id, payload) VALUES (${command.project.id}, ${encode(command.project)})`
            yield* sql`INSERT INTO workspace_checkout (id, project_id, payload) VALUES (${command.mainCheckout.id}, ${command.project.id}, ${encode({ ...command.mainCheckout, projectId: command.project.id })})`
          }),
        )
      }),
    )

  const createTask = (command: Parameters<WorkspaceStore['Service']['createTask']>[0]) =>
    guard(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(createTaskCommandSchema)(command).pipe(
          Effect.mapError(() => safeError('invalid-data', 'Task creation data is invalid')),
        )
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const projects = yield* sql`SELECT id FROM workspace_project WHERE id = ${command.task.projectId}`
            if (projects.length === 0) return yield* Effect.fail(safeError('not-found', 'Project does not exist'))
            yield* sql`INSERT INTO workspace_task (id, project_id, archived, payload) VALUES (${command.task.id}, ${command.task.projectId}, 0, ${encode({ ...command.task, status: 'open', updatedAt: command.task.createdAt })})`
            yield* sql`INSERT INTO workspace_conversation (id, task_id, payload) VALUES (${command.conversation.id}, ${command.task.id}, ${encode({ ...command.conversation, taskId: command.task.id })})`
          }),
        )
      }),
    )

  const beginRun = (command: BeginRunCommand) =>
    guard(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(beginRunCommandSchema)(command).pipe(
          Effect.mapError(() => safeError('invalid-data', 'Run command data is invalid')),
        )
        const receipt = yield* sql.withTransaction(
          Effect.gen(function* () {
            const commandFingerprint = fingerprint(command)
            const prior =
              yield* sql`SELECT fingerprint, payload FROM workspace_command_receipt WHERE command_id = ${command.commandId}`
            if (prior[0]) {
              if (prior[0].fingerprint !== commandFingerprint)
                return yield* Effect.fail(
                  safeError('command-conflict', 'Command ID was already used with different input'),
                )
              const saved = yield* decodeJson(
                Schema.Struct({
                  commandId: Schema.String,
                  runId: Schema.String,
                  acceptedAt: Schema.String,
                  replayed: Schema.Boolean,
                }),
              )(String(prior[0].payload))
              return { ...saved, replayed: true } as CommandReceipt
            }

            const rows = yield* sql`
        SELECT t.project_id AS task_project, t.archived, c.task_id AS conversation_task,
          w.project_id AS checkout_project, w.payload AS checkout_payload
        FROM workspace_task t
        JOIN workspace_conversation c ON c.id = ${command.conversationId}
        JOIN workspace_checkout w ON w.id = ${command.checkoutId}
        WHERE t.id = ${command.taskId}
      `
            if (rows.length === 0)
              return yield* Effect.fail(safeError('not-found', 'Task, Conversation or checkout does not exist'))
            const membership = rows[0] as {
              task_project: string
              archived: number
              conversation_task: string
              checkout_project: string
              checkout_payload: string
            }
            if (
              membership.archived ||
              membership.conversation_task !== command.taskId ||
              membership.task_project !== membership.checkout_project
            ) {
              return yield* Effect.fail(
                safeError(
                  'membership-conflict',
                  'Task, Conversation and checkout must belong to the same active Project',
                ),
              )
            }

            if (command.nativeSessionId) {
              const knownSessions = yield* sql`
        SELECT task_id, conversation_id, checkout_id, generation
        FROM workspace_agent_session
        WHERE driver_id = ${command.driverId} AND connection_id = ${command.connectionId}
          AND native_session_id = ${command.nativeSessionId}
      `
              if (
                knownSessions[0] &&
                (knownSessions[0].task_id !== command.taskId ||
                  knownSessions[0].conversation_id !== command.conversationId ||
                  knownSessions[0].checkout_id !== command.checkoutId ||
                  Number(knownSessions[0].generation) !== command.generation)
              ) {
                return yield* Effect.fail(
                  safeError('membership-conflict', 'Native session identity belongs to another execution context'),
                )
              }
            }

            const requestedCheckout = yield* decodeJson(workspaceCheckoutSchema)(membership.checkout_payload)
            const active = yield* sql`
        SELECT DISTINCT c.payload AS checkout_payload FROM workspace_agent_run r
        JOIN workspace_checkout c ON c.id = r.checkout_id
        WHERE r.status IN ('queued', 'starting', 'running', 'awaitingInput', 'interruptRequested', 'uncertain', 'recoveryRequired')
      `
            const activeCheckouts = yield* Effect.forEach(active as Array<{ checkout_payload: unknown }>, row =>
              decodeJson(workspaceCheckoutSchema)(String(row.checkout_payload)),
            )
            if (activeCheckouts.some(activeCheckout => activeCheckout.path === requestedCheckout.path))
              return yield* Effect.fail(
                safeError('admission-conflict', 'Workspace path has an active or unresolved Run'),
              )
            const sessionRuns = yield* sql`
        SELECT r.id FROM workspace_agent_run r
        JOIN workspace_dispatch_intent i ON i.run_id = r.id
        WHERE (r.session_id = ${command.provisionalAgentSessionId} OR i.provisional_session_id = ${command.provisionalAgentSessionId})
          AND r.status IN ('queued', 'starting', 'running', 'awaitingInput', 'interruptRequested', 'uncertain', 'recoveryRequired')
      `
            if (sessionRuns.length > 0)
              return yield* Effect.fail(safeError('admission-conflict', 'Agent Session already has an active turn'))

            const previous = command.retryOfRunId
              ? yield* sql`SELECT payload FROM workspace_agent_run WHERE id = ${command.retryOfRunId} AND task_id = ${command.taskId}`
              : []
            if (command.retryOfRunId && previous.length === 0)
              return yield* Effect.fail(safeError('not-found', 'Retry source Run does not exist for this Task'))
            let attempt = 1
            if (previous[0]) {
              const previousRun = yield* decodeRun(String(previous[0].payload))
              if (!['failed', 'interrupted', 'uncertain', 'recoveryRequired'].includes(previousRun.status))
                return yield* Effect.fail(
                  safeError('invalid-transition', 'Only a terminal unsuccessful Run can be retried'),
                )
              attempt = previousRun.attempt + 1
            }
            const run: AgentRun = {
              id: command.runId,
              taskId: command.taskId,
              sessionId: null,
              attempt,
              retryOfRunId: command.retryOfRunId ?? null,
              generation: command.generation,
              status: 'queued',
              submittedAt: command.issuedAt,
              startedAt: null,
              finishedAt: null,
              nativeTurnId: null,
              failure: null,
            }
            yield* sql`INSERT INTO workspace_agent_run (id, task_id, checkout_id, generation, status, submitted_at, payload) VALUES (${run.id}, ${run.taskId}, ${command.checkoutId}, ${run.generation}, 'queued', ${run.submittedAt}, ${encode(run)})`
            yield* sql`INSERT INTO workspace_message (id, run_id, conversation_id, role, content, created_at) VALUES (${`user:${run.id}`}, ${run.id}, ${command.conversationId}, 'user', ${command.prompt}, ${command.issuedAt})`
            yield* sql`INSERT INTO workspace_dispatch_intent (run_id, task_id, provisional_session_id, conversation_id, driver_id, connection_id, checkout_id, generation, prompt, model_id, mode_id, requested_native_session_id, state) VALUES (${run.id}, ${command.taskId}, ${command.provisionalAgentSessionId}, ${command.conversationId}, ${command.driverId}, ${command.connectionId}, ${command.checkoutId}, ${command.generation}, ${command.prompt}, ${command.modelId ?? null}, ${command.modeId ?? null}, ${command.nativeSessionId ?? null}, 'pending')`
            yield* appendEvent(run, 'runQueued', command.issuedAt, { conversationId: command.conversationId })
            const result: CommandReceipt = {
              commandId: command.commandId,
              runId: run.id,
              acceptedAt: command.issuedAt,
              replayed: false,
            }
            yield* sql`INSERT INTO workspace_command_receipt (command_id, fingerprint, payload) VALUES (${command.commandId}, ${commandFingerprint}, ${encode(result)})`
            return result
          }),
        )
        return receipt
      }),
    )

  const claimDispatch = (
    runId: Parameters<WorkspaceStore['Service']['claimDispatch']>[0],
    ownerEpoch: number,
    claimedAt: string,
  ) =>
    guard(
      Effect.gen(function* () {
        yield* decodeWorkerEpoch(ownerEpoch)
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const worker = yield* sql`SELECT retired_epoch FROM workspace_worker_epoch WHERE singleton = 1`
            if (ownerEpoch <= Number(worker[0]?.retired_epoch ?? 0))
              return yield* Effect.fail(safeError('stale-epoch', 'Worker epoch has already been retired'))
            const rows = yield* sql`
              SELECT i.*, r.payload AS run_payload, r.task_id AS run_task_id,
                r.checkout_id AS run_checkout_id, r.generation AS run_generation,
                t.project_id AS project_id, t.archived,
                c.project_id AS checkout_project_id, c.payload AS checkout_payload
              FROM workspace_dispatch_intent i
              JOIN workspace_agent_run r ON r.id = i.run_id
              JOIN workspace_task t ON t.id = r.task_id
              JOIN workspace_checkout c ON c.id = r.checkout_id
              WHERE i.run_id = ${runId}
            `
            if (!rows[0]) return yield* Effect.fail(safeError('not-found', 'Dispatch intent does not exist'))
            const intent = rows[0] as Record<string, unknown>
            if (intent.state !== 'pending')
              return yield* Effect.fail(safeError('admission-conflict', 'Dispatch intent is not pending'))
            const current = yield* decodeRun(String(intent.run_payload))
            if (
              intent.task_id !== intent.run_task_id ||
              intent.checkout_id !== intent.run_checkout_id ||
              Number(intent.generation) !== Number(intent.run_generation) ||
              current.generation !== Number(intent.generation) ||
              intent.archived ||
              intent.project_id !== intent.checkout_project_id
            ) {
              return yield* Effect.fail(
                safeError('membership-conflict', 'Dispatch Task and checkout membership is inconsistent'),
              )
            }
            const checkout = yield* decodeJson(workspaceCheckoutSchema)(String(intent.checkout_payload))
            const projectId = yield* Schema.decodeUnknownEffect(projectIdSchema)(intent.project_id).pipe(
              Effect.mapError(() => safeError('invalid-data', 'Stored project identity failed validation')),
            )
            if (checkout.id !== intent.checkout_id || checkout.projectId !== projectId)
              return yield* Effect.fail(
                safeError('membership-conflict', 'Dispatch checkout payload does not match stored membership'),
              )
            const run = yield* transition(current, 'starting', claimedAt)
            yield* sql`UPDATE workspace_dispatch_intent SET state = 'claimed', owner_epoch = ${ownerEpoch} WHERE run_id = ${runId} AND state = 'pending'`
            yield* persistRun(run)
            yield* appendEvent(run, 'dispatchClaimed', claimedAt, { ownerEpoch })
            return {
              runId,
              projectId,
              taskId: String(intent.task_id),
              conversationId: String(intent.conversation_id),
              ownerEpoch,
              provisionalAgentSessionId: String(intent.provisional_session_id),
              driverId: String(intent.driver_id),
              connectionId: String(intent.connection_id),
              checkoutId: String(intent.checkout_id),
              workspacePath: checkout.path,
              generation: Number(intent.generation),
              prompt: String(intent.prompt),
              modelId: intent.model_id as string | null,
              modeId: intent.mode_id as string | null,
              nativeSessionId: intent.requested_native_session_id as string | null,
            } as DispatchClaim
          }),
        )
      }),
    )

  const acknowledgeDispatch = (
    runId: Parameters<WorkspaceStore['Service']['acknowledgeDispatch']>[0],
    acknowledgement: Parameters<WorkspaceStore['Service']['acknowledgeDispatch']>[1],
  ) =>
    guard(
      Effect.gen(function* () {
        yield* decodeWorkerEpoch(acknowledgement.ownerEpoch)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows =
              yield* sql`SELECT i.*, r.task_id, r.payload AS run_payload FROM workspace_dispatch_intent i JOIN workspace_agent_run r ON r.id = i.run_id WHERE i.run_id = ${runId}`
            if (!rows[0]) return yield* Effect.fail(safeError('not-found', 'Dispatch intent does not exist'))
            const intent = rows[0] as Record<string, unknown>
            if (intent.state !== 'claimed' || Number(intent.owner_epoch) !== acknowledgement.ownerEpoch)
              return yield* Effect.fail(
                safeError('stale-epoch', 'Dispatch acknowledgement does not match the current claim'),
              )
            if (
              intent.requested_native_session_id &&
              intent.requested_native_session_id !== acknowledgement.nativeSessionId
            ) {
              return yield* Effect.fail(
                safeError('membership-conflict', 'Native acknowledgement does not match the requested session'),
              )
            }
            const existing =
              yield* sql`SELECT id, task_id, conversation_id, checkout_id, generation, driver_id, connection_id FROM workspace_agent_session WHERE driver_id = ${intent.driver_id} AND connection_id = ${intent.connection_id} AND native_session_id = ${acknowledgement.nativeSessionId}`
            let sessionId = String(intent.provisional_session_id)
            if (existing[0]) {
              const session = existing[0] as Record<string, unknown>
              if (
                session.task_id !== intent.task_id ||
                session.conversation_id !== intent.conversation_id ||
                session.checkout_id !== intent.checkout_id ||
                Number(session.generation) !== Number(intent.generation) ||
                session.driver_id !== intent.driver_id ||
                session.connection_id !== intent.connection_id
              ) {
                return yield* Effect.fail(
                  safeError('membership-conflict', 'Native session identity belongs to another execution context'),
                )
              }
              sessionId = String(session.id)
            } else {
              yield* sql`INSERT INTO workspace_agent_session (id, task_id, conversation_id, checkout_id, generation, driver_id, connection_id, native_session_id, status) VALUES (${intent.provisional_session_id}, ${intent.task_id}, ${intent.conversation_id}, ${intent.checkout_id}, ${Number(intent.generation)}, ${intent.driver_id}, ${intent.connection_id}, ${acknowledgement.nativeSessionId}, 'active')`
            }
            const current = yield* decodeRun(String(intent.run_payload))
            if (
              (current.nativeTurnId &&
                acknowledgement.nativeTurnId &&
                current.nativeTurnId !== acknowledgement.nativeTurnId) ||
              (intent.native_turn_id &&
                acknowledgement.nativeTurnId &&
                intent.native_turn_id !== acknowledgement.nativeTurnId)
            ) {
              return yield* Effect.fail(
                safeError('membership-conflict', 'Native turn identity changed during acknowledgement'),
              )
            }
            const wasInterruptRequested = current.status === 'interruptRequested'
            const transitionSource = wasInterruptRequested ? { ...current, status: 'starting' as const } : current
            const startedRun = yield* transition(transitionSource, 'running', acknowledgement.acknowledgedAt, {
              nativeTurnId: acknowledgement.nativeTurnId ?? current.nativeTurnId ?? null,
            })
            const run = wasInterruptRequested ? { ...startedRun, status: 'interruptRequested' as const } : startedRun
            const associatedRun = { ...run, sessionId: sessionId as AgentRun['sessionId'] }
            yield* sql`UPDATE workspace_agent_run SET session_id = ${sessionId}, payload = ${encode(associatedRun)}, status = ${associatedRun.status} WHERE id = ${runId}`
            yield* sql`UPDATE workspace_dispatch_intent SET state = 'accepted', native_session_id = ${acknowledgement.nativeSessionId}, native_turn_id = ${acknowledgement.nativeTurnId ?? current.nativeTurnId ?? null} WHERE run_id = ${runId}`
            yield* appendEvent(run, 'runStarted', acknowledgement.acknowledgedAt, {
              nativeTurnId: acknowledgement.nativeTurnId ?? null,
            })
          }),
        )
      }),
    )

  const loadOwnedDispatch = (runId: string, ownerEpoch: number, requireSession = false) =>
    Effect.gen(function* () {
      yield* decodeWorkerEpoch(ownerEpoch)
      const rows = yield* sql`
        SELECT i.*, r.task_id AS run_task_id, r.session_id AS run_session_id,
          r.checkout_id AS run_checkout_id, r.generation AS run_generation, r.payload AS run_payload,
          t.project_id AS task_project_id, c.project_id AS checkout_project_id, c.payload AS checkout_payload,
          s.task_id AS session_task_id, s.conversation_id AS session_conversation_id,
          s.checkout_id AS session_checkout_id, s.generation AS session_generation,
          s.driver_id AS session_driver_id, s.connection_id AS session_connection_id,
          s.native_session_id AS session_native_session_id
        FROM workspace_dispatch_intent i
        JOIN workspace_agent_run r ON r.id = i.run_id
        JOIN workspace_task t ON t.id = r.task_id
        JOIN workspace_checkout c ON c.id = r.checkout_id
        LEFT JOIN workspace_agent_session s ON s.id = r.session_id
        WHERE i.run_id = ${runId}
      `
      if (!rows[0]) return yield* Effect.fail(safeError('not-found', 'Dispatch intent does not exist'))
      const row = rows[0] as Record<string, unknown>
      const retired = yield* sql`SELECT retired_epoch FROM workspace_worker_epoch WHERE singleton = 1`
      if (ownerEpoch <= Number(retired[0]?.retired_epoch ?? 0) || Number(row.owner_epoch) !== ownerEpoch)
        return yield* Effect.fail(safeError('stale-epoch', 'Operation does not belong to the current worker epoch'))

      const run = yield* decodeRun(String(row.run_payload))
      if (
        run.id !== runId ||
        row.task_id !== row.run_task_id ||
        row.checkout_id !== row.run_checkout_id ||
        Number(row.generation) !== Number(row.run_generation) ||
        run.generation !== Number(row.generation) ||
        row.task_project_id !== row.checkout_project_id
      ) {
        return yield* Effect.fail(safeError('membership-conflict', 'Run, Task and checkout membership is inconsistent'))
      }
      const projectId = yield* Schema.decodeUnknownEffect(projectIdSchema)(row.task_project_id).pipe(
        Effect.mapError(() => safeError('invalid-data', 'Stored project identity failed validation')),
      )
      const checkout = yield* decodeJson(workspaceCheckoutSchema)(String(row.checkout_payload))
      if (checkout.id !== row.checkout_id || checkout.projectId !== projectId)
        return yield* Effect.fail(safeError('membership-conflict', 'Stored checkout payload has different membership'))

      if (
        requireSession &&
        (!run.sessionId ||
          row.run_session_id !== run.sessionId ||
          row.session_task_id !== row.task_id ||
          row.session_conversation_id !== row.conversation_id ||
          row.session_checkout_id !== row.checkout_id ||
          Number(row.session_generation) !== Number(row.generation) ||
          row.session_driver_id !== row.driver_id ||
          row.session_connection_id !== row.connection_id ||
          row.session_native_session_id !== row.native_session_id)
      ) {
        return yield* Effect.fail(safeError('membership-conflict', 'Agent Session does not match the current Run'))
      }
      return { row, run, checkout }
    })

  const decodeStoredEvent = (row: Record<string, unknown>) =>
    Effect.gen(function* () {
      const data = yield* decodeJson(Schema.Record(Schema.String, Schema.Unknown))(String(row.payload))
      return yield* Schema.decodeUnknownEffect(workspaceExecutionEventSchema)({
        sequence: Number(row.sequence),
        schemaVersion: Number(row.schema_version),
        kind: row.kind,
        runId: row.run_id,
        taskId: row.task_id,
        generation: Number(row.generation),
        occurredAt: row.occurred_at,
        data,
      }).pipe(Effect.mapError(() => safeError('invalid-data', 'Stored workspace event failed validation')))
    })

  const recordDriverEvent = (
    runId: Parameters<WorkspaceStore['Service']['recordDriverEvent']>[0],
    command: Parameters<WorkspaceStore['Service']['recordDriverEvent']>[1],
  ) =>
    guard(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(recordDriverEventCommandSchema)(command).pipe(
          Effect.mapError(() => safeError('invalid-data', 'Driver event command is invalid')),
        )
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const { row, run } = yield* loadOwnedDispatch(runId, command.ownerEpoch, true)
            if (command.generation !== run.generation || command.generation !== Number(row.generation))
              return yield* Effect.fail(
                safeError('membership-conflict', 'Driver event generation does not match the Run'),
              )

            const eventFingerprint = fingerprint(command)
            const prior = yield* sql`
              SELECT fingerprint, sequence FROM workspace_driver_event_identity
              WHERE run_id = ${runId} AND event_id = ${command.eventId}
            `
            if (prior[0]) {
              if (prior[0].fingerprint !== eventFingerprint)
                return yield* Effect.fail(
                  safeError('command-conflict', 'Driver event ID was already used with different input'),
                )
              const savedRows = yield* sql`
                SELECT sequence, schema_version, kind, run_id, task_id, generation, occurred_at, payload
                FROM workspace_execution_event WHERE sequence = ${Number(prior[0].sequence)}
              `
              if (!savedRows[0])
                return yield* Effect.fail(safeError('invalid-data', 'Committed driver event is missing'))
              return yield* decodeStoredEvent(savedRows[0] as Record<string, unknown>)
            }
            if (row.state !== 'accepted') {
              if (run.status === 'completed' || run.status === 'failed' || run.status === 'interrupted')
                return yield* Effect.fail(
                  safeError('invalid-transition', 'Terminal Run cannot accept another driver event'),
                )
              return yield* Effect.fail(safeError('stale-epoch', 'Driver event dispatch is no longer accepted'))
            }

            const event = command.event as AgentDriverEvent
            if (event.kind === 'requestPending') {
              const priorRequest = yield* sql`
                SELECT state FROM workspace_driver_request_state
                WHERE run_id = ${runId} AND request_id = ${event.request.requestId}
              `
              if (
                event.request.runId !== run.id ||
                event.request.generation !== run.generation ||
                (event.request.sessionId !== undefined && event.request.sessionId !== run.sessionId) ||
                priorRequest.length > 0
              ) {
                return yield* Effect.fail(safeError('membership-conflict', 'Agent request does not belong to this Run'))
              }
            } else if (event.kind === 'requestResolved') {
              const request = yield* sql`
                SELECT state FROM workspace_driver_request_state
                WHERE run_id = ${runId} AND request_id = ${event.requestId}
              `
              if (request[0]?.state !== 'pending')
                return yield* Effect.fail(
                  safeError('membership-conflict', 'Agent request response has no unresolved request in this Run'),
                )
            }

            const suppliedTurnId =
              event.kind === 'turnStarted' ||
              event.kind === 'turnCompleted' ||
              event.kind === 'turnInterrupted' ||
              event.kind === 'turnFailed'
                ? event.nativeTurnId
                : undefined
            const currentTurnId = run.nativeTurnId ?? (row.native_turn_id as string | null) ?? null
            if (
              suppliedTurnId &&
              ((currentTurnId && suppliedTurnId !== currentTurnId) ||
                (row.native_turn_id && suppliedTurnId !== row.native_turn_id))
            ) {
              return yield* Effect.fail(safeError('membership-conflict', 'Driver event native turn ID changed'))
            }
            const nativeTurnId = suppliedTurnId ?? currentTurnId
            let updatedRun = run
            const transitionWithNativeId = (
              status: AgentRunStatus,
              details: Parameters<typeof transitionAgentRun>[3] = {},
            ) =>
              transition(run, status, command.occurredAt, {
                ...details,
                ...(nativeTurnId !== null ? { nativeTurnId } : {}),
              })

            if (run.status === 'completed' || run.status === 'failed' || run.status === 'interrupted')
              return yield* Effect.fail(
                safeError('invalid-transition', 'Terminal Run cannot accept another driver event'),
              )
            switch (event.kind) {
              case 'turnStarted':
                if (run.status === 'starting' || run.status === 'awaitingInput')
                  updatedRun = yield* transitionWithNativeId('running')
                else if (run.status !== 'running' && run.status !== 'interruptRequested')
                  return yield* Effect.fail(safeError('invalid-transition', 'Turn start is not valid for this Run'))
                break
              case 'turnCompleted':
                updatedRun = yield* transitionWithNativeId('completed')
                break
              case 'turnInterrupted':
                updatedRun = yield* transitionWithNativeId('interrupted')
                break
              case 'turnFailed':
                updatedRun = yield* transitionWithNativeId('failed', { failure: 'driver-failed' })
                break
              case 'requestPending':
                if (run.status === 'running') updatedRun = yield* transitionWithNativeId('awaitingInput')
                else if (run.status !== 'awaitingInput' && run.status !== 'interruptRequested')
                  return yield* Effect.fail(safeError('invalid-transition', 'Agent request is not valid for this Run'))
                break
              case 'requestResolved':
                if (run.status === 'awaitingInput') {
                  const unresolvedRequests = yield* sql`
                    SELECT request_id FROM workspace_driver_request_state
                    WHERE run_id = ${runId} AND state = 'pending' AND request_id <> ${event.requestId}
                  `
                  if (unresolvedRequests.length === 0) updatedRun = yield* transitionWithNativeId('running')
                } else if (run.status !== 'running' && run.status !== 'interruptRequested')
                  return yield* Effect.fail(safeError('invalid-transition', 'Agent response is not valid for this Run'))
                break
              default:
                break
            }
            if (nativeTurnId !== null && updatedRun.nativeTurnId !== nativeTurnId)
              updatedRun = { ...updatedRun, nativeTurnId }

            yield* persistRun(updatedRun)
            if (event.kind === 'requestPending') {
              yield* sql`
                INSERT INTO workspace_driver_request_state (run_id, request_id, state)
                VALUES (${runId}, ${event.request.requestId}, 'pending')
              `
            } else if (event.kind === 'requestResolved') {
              yield* sql`
                UPDATE workspace_driver_request_state SET state = 'resolved'
                WHERE run_id = ${runId} AND request_id = ${event.requestId} AND state = 'pending'
              `
              const responses =
                yield* sql`SELECT payload FROM workspace_request_response_intent WHERE run_id = ${runId} AND request_id = ${event.requestId}`
              if (responses[0]) {
                const response = yield* decodeJson(requestResponseIntentSchema)(String(responses[0].payload))
                yield* sql`UPDATE workspace_request_response_intent SET state = 'resolved', payload = ${encode({ ...response, state: 'resolved' })} WHERE run_id = ${runId} AND request_id = ${event.requestId}`
              }
            } else if (
              event.kind === 'turnCompleted' ||
              event.kind === 'turnInterrupted' ||
              event.kind === 'turnFailed'
            ) {
              yield* sql`
                UPDATE workspace_driver_request_state SET state = 'expired'
                WHERE run_id = ${runId} AND state = 'pending'
              `
              yield* sql`
                UPDATE workspace_dispatch_intent SET state = 'settled'
                WHERE run_id = ${runId} AND state = 'accepted'
              `
            }
            if (nativeTurnId !== null)
              yield* sql`UPDATE workspace_dispatch_intent SET native_turn_id = ${nativeTurnId} WHERE run_id = ${runId}`
            const data = { eventId: command.eventId, event: command.event }
            const sequence = yield* appendEvent(updatedRun, 'driverEvent', command.occurredAt, data)
            yield* sql`
              INSERT INTO workspace_driver_event_identity (run_id, event_id, fingerprint, sequence)
              VALUES (${runId}, ${command.eventId}, ${eventFingerprint}, ${sequence})
            `
            return yield* Schema.decodeUnknownEffect(workspaceExecutionEventSchema)({
              sequence,
              schemaVersion: 1,
              kind: 'driverEvent',
              runId: updatedRun.id,
              taskId: updatedRun.taskId,
              generation: updatedRun.generation,
              occurredAt: command.occurredAt,
              data,
            }).pipe(Effect.mapError(() => safeError('invalid-data', 'Committed driver event failed validation')))
          }),
        )
      }),
    )

  const failDispatch = (
    runId: Parameters<WorkspaceStore['Service']['failDispatch']>[0],
    command: Parameters<WorkspaceStore['Service']['failDispatch']>[1],
  ) =>
    guard(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(dispatchFailureCommandSchema)(command).pipe(
          Effect.mapError(() => safeError('invalid-data', 'Dispatch failure command is invalid')),
        )
        yield* decodeWorkerEpoch(command.ownerEpoch)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const intentRows = yield* sql`
              SELECT i.state, i.owner_epoch, r.payload AS run_payload
              FROM workspace_dispatch_intent i
              JOIN workspace_agent_run r ON r.id = i.run_id
              WHERE i.run_id = ${runId}
            `
            if (!intentRows[0]) return yield* Effect.fail(safeError('not-found', 'Dispatch intent does not exist'))
            let row = intentRows[0] as Record<string, unknown>
            let run: AgentRun
            const pendingLaunchFailure = row.state === 'pending' && row.owner_epoch === null
            if (pendingLaunchFailure) {
              if (command.outcome !== 'failed' || command.reason !== 'launch-failed')
                return yield* Effect.fail(
                  safeError('invalid-transition', 'Pending dispatch can only fail before launch'),
                )
              const worker = yield* sql`SELECT retired_epoch FROM workspace_worker_epoch WHERE singleton = 1`
              if (command.ownerEpoch <= Number(worker[0]?.retired_epoch ?? 0))
                return yield* Effect.fail(safeError('stale-epoch', 'Worker epoch has already been retired'))
              run = yield* decodeRun(String(row.run_payload))
            } else {
              const owned = yield* loadOwnedDispatch(runId, command.ownerEpoch)
              row = owned.row
              run = owned.run
            }
            if (
              ((row.state === 'failed' && run.status === 'failed') ||
                (row.state === 'uncertain' && run.status === 'uncertain')) &&
              run.failure === command.reason
            ) {
              return
            }
            const definitePreSubmitFailure =
              (row.state === 'pending' || row.state === 'claimed') &&
              command.outcome === 'failed' &&
              command.reason === 'launch-failed'
            const outcome = definitePreSubmitFailure ? 'failed' : 'uncertain'
            const terminalStatus = outcome === 'failed' ? 'failed' : 'uncertain'
            if (row.state !== 'pending' && row.state !== 'claimed' && row.state !== 'accepted')
              return yield* Effect.fail(safeError('invalid-transition', 'Dispatch can no longer be failed'))
            const failedRun = yield* transition(run, terminalStatus, command.occurredAt, {
              failure: command.reason,
            })
            yield* persistRun(failedRun)
            if (pendingLaunchFailure) {
              yield* sql`
                UPDATE workspace_dispatch_intent SET state = 'failed', owner_epoch = ${command.ownerEpoch}
                WHERE run_id = ${runId} AND state = 'pending' AND owner_epoch IS NULL
              `
            } else {
              yield* sql`UPDATE workspace_dispatch_intent SET state = ${outcome} WHERE run_id = ${runId}`
            }
            yield* appendEvent(
              failedRun,
              terminalStatus === 'failed' ? 'runFailed' : 'runUncertain',
              command.occurredAt,
              {
                reason: command.reason,
              },
            )
          }),
        )
      }),
    )

  const requestInterrupt = (
    runId: Parameters<WorkspaceStore['Service']['requestInterrupt']>[0],
    ownerEpoch: number,
    requestedAt: string,
  ) =>
    guard(
      Effect.gen(function* () {
        yield* decodeWorkerEpoch(ownerEpoch)
        yield* Schema.decodeUnknownEffect(timestampSchema)(requestedAt).pipe(
          Effect.mapError(() => safeError('invalid-data', 'Interrupt request timestamp is invalid')),
        )
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const { row, run } = yield* loadOwnedDispatch(runId, ownerEpoch)
            if (run.status === 'interruptRequested') return
            if (row.state !== 'claimed' && row.state !== 'accepted')
              return yield* Effect.fail(
                safeError('invalid-transition', 'Run cannot be interrupted in its current state'),
              )
            const interrupted = yield* transition(run, 'interruptRequested', requestedAt)
            yield* persistRun(interrupted)
            yield* appendEvent(interrupted, 'runInterruptRequested', requestedAt, { ownerEpoch })
          }),
        )
      }),
    )

  function deliveryOutcome(command: SettleDeliveryCommand): WorkspaceDeliveryOutcome {
    return {
      outcome: command.outcome,
      ...(command.nativeConfirmation === undefined ? {} : { nativeConfirmation: command.nativeConfirmation }),
      ...(command.nativeRequestId === undefined ? {} : { nativeRequestId: command.nativeRequestId }),
    }
  }

  const replayReceipt = Effect.fnUntraced(function* (command: { readonly commandId: string }) {
    const prior =
      yield* sql`SELECT fingerprint, payload FROM workspace_command_receipt WHERE command_id = ${command.commandId}`
    if (!prior[0]) return undefined
    if (prior[0].fingerprint !== fingerprint(command))
      return yield* Effect.fail(safeError('command-conflict', 'Command ID was already used with different input'))
    const receipt = yield* decodeJson(commandReceiptSchema)(String(prior[0].payload))
    return { ...receipt, replayed: true }
  })

  const saveReceipt = Effect.fnUntraced(function* (command: {
    readonly commandId: string
    readonly runId: AgentRun['id']
    readonly issuedAt: string
  }) {
    const receipt: CommandReceipt = {
      commandId: command.commandId,
      runId: command.runId,
      acceptedAt: command.issuedAt,
      replayed: false,
    }
    yield* sql`INSERT INTO workspace_command_receipt (command_id, fingerprint, payload) VALUES (${command.commandId}, ${fingerprint(command)}, ${encode(receipt)})`
    return receipt
  })

  const validateCommandBytes = (command: unknown) =>
    Buffer.byteLength(encode(command), 'utf8') <= WORKSPACE_STORE_COMMAND_BYTE_CAPACITY
      ? Effect.void
      : Effect.fail(safeError('invalid-data', 'Workspace command exceeds the byte limit'))

  const recordRequestResponse: WorkspaceStore['Service']['recordRequestResponse'] = command =>
    guard(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(recordRequestResponseCommandSchema)(command).pipe(
          Effect.mapError(() => safeError('invalid-data', 'Request response command is invalid')),
        )
        yield* validateCommandBytes(command)
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const replay = yield* replayReceipt(command)
            if (replay) return replay
            const { run } = yield* loadOwnedDispatch(command.runId, command.ownerEpoch, true)
            const pending =
              yield* sql`SELECT state FROM workspace_driver_request_state WHERE run_id = ${command.runId} AND request_id = ${command.requestId}`
            const prior =
              yield* sql`SELECT state FROM workspace_request_response_intent WHERE run_id = ${command.runId} AND request_id = ${command.requestId}`
            if (run.generation !== command.generation || pending[0]?.state !== 'pending' || prior.length > 0)
              return yield* Effect.fail(safeError('stale-request', 'Request is no longer available for a response'))
            const intent = { ...command, state: 'pending' as const }
            yield* sql`INSERT INTO workspace_request_response_intent (run_id, request_id, state, payload) VALUES (${command.runId}, ${command.requestId}, 'pending', ${encode(intent)})`
            yield* appendEvent(run, 'requestResponseRecorded', command.issuedAt, {
              commandId: command.commandId,
              requestId: command.requestId,
            })
            return yield* saveReceipt(command)
          }),
        )
      }),
    )

  const settleRequestResponse: WorkspaceStore['Service']['settleRequestResponse'] = (runId, requestId, outcome) =>
    guard(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(settleDeliveryCommandSchema)(outcome).pipe(
          Effect.mapError(() => safeError('invalid-data', 'Delivery outcome is invalid')),
        )
        yield* validateCommandBytes(outcome)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const { run } = yield* loadOwnedDispatch(runId, outcome.ownerEpoch, true)
            const rows =
              yield* sql`SELECT payload FROM workspace_request_response_intent WHERE run_id = ${runId} AND request_id = ${requestId}`
            if (!rows[0]) return yield* Effect.fail(safeError('not-found', 'Request response intent does not exist'))
            const intent = yield* decodeJson(requestResponseIntentSchema)(String(rows[0].payload))
            const delivery = deliveryOutcome(outcome)
            if (intent.delivery) {
              if (fingerprint(intent.delivery) === fingerprint(delivery)) return
              return yield* Effect.fail(safeError('invalid-transition', 'Delivery was already settled'))
            }
            const state = intent.state === 'resolved' ? 'resolved' : outcome.outcome
            yield* sql`UPDATE workspace_request_response_intent SET state = ${state}, payload = ${encode({ ...intent, state, delivery })} WHERE run_id = ${runId} AND request_id = ${requestId}`
            yield* appendEvent(run, 'requestResponseSettled', outcome.occurredAt, { requestId, ...delivery })
          }),
        )
      }),
    )

  const recordSteer: WorkspaceStore['Service']['recordSteer'] = command =>
    guard(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(recordSteerCommandSchema)(command).pipe(
          Effect.mapError(() => safeError('invalid-data', 'Steering command is invalid')),
        )
        yield* validateCommandBytes(command)
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const replay = yield* replayReceipt(command)
            if (replay) return replay
            const { run } = yield* loadOwnedDispatch(command.runId, command.ownerEpoch)
            if (run.status === 'completed' || run.status === 'failed' || run.status === 'interrupted')
              return yield* Effect.fail(safeError('invalid-transition', 'Terminal Run cannot accept steering'))
            if (
              command.generation !== run.generation ||
              (command.expectedNativeTurnId !== undefined && command.expectedNativeTurnId !== run.nativeTurnId)
            )
              return yield* Effect.fail(
                safeError('membership-conflict', 'Steering does not match the current generation or native turn'),
              )
            yield* sql`INSERT INTO workspace_steer_intent (command_id, run_id, state, payload) VALUES (${command.commandId}, ${command.runId}, 'pending', ${encode({ ...command, state: 'pending' })})`
            yield* appendEvent(run, 'steerRecorded', command.issuedAt, { commandId: command.commandId })
            return yield* saveReceipt(command)
          }),
        )
      }),
    )

  const settleSteer: WorkspaceStore['Service']['settleSteer'] = (runId, commandId, outcome) =>
    guard(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(settleDeliveryCommandSchema)(outcome).pipe(
          Effect.mapError(() => safeError('invalid-data', 'Delivery outcome is invalid')),
        )
        yield* validateCommandBytes(outcome)
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const { run } = yield* loadOwnedDispatch(runId, outcome.ownerEpoch)
            const rows =
              yield* sql`SELECT payload FROM workspace_steer_intent WHERE run_id = ${runId} AND command_id = ${commandId}`
            if (!rows[0]) return yield* Effect.fail(safeError('not-found', 'Steering intent does not exist'))
            const intent = yield* decodeJson(steerIntentSchema)(String(rows[0].payload))
            const delivery = deliveryOutcome(outcome)
            if (intent.delivery) {
              if (fingerprint(intent.delivery) === fingerprint(delivery)) return
              return yield* Effect.fail(safeError('invalid-transition', 'Delivery was already settled'))
            }
            yield* sql`UPDATE workspace_steer_intent SET state = ${outcome.outcome}, payload = ${encode({ ...intent, state: outcome.outcome, delivery })} WHERE run_id = ${runId} AND command_id = ${commandId}`
            yield* appendEvent(run, 'steerSettled', outcome.occurredAt, { commandId, ...delivery })
          }),
        )
      }),
    )

  const enqueueFollowUp: WorkspaceStore['Service']['enqueueFollowUp'] = command =>
    guard(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(enqueueFollowUpCommandSchema)(command).pipe(
          Effect.mapError(() => safeError('invalid-data', 'Follow-up command is invalid')),
        )
        yield* validateCommandBytes(command)
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const prior =
              yield* sql`SELECT fingerprint, payload FROM workspace_command_receipt WHERE command_id = ${command.commandId}`
            if (prior[0]) {
              if (prior[0].fingerprint !== fingerprint(command))
                return yield* Effect.fail(
                  safeError('command-conflict', 'Command ID was already used with different input'),
                )
              const receipt = yield* decodeJson(followUpReceiptSchema)(String(prior[0].payload))
              return { ...receipt, replayed: true }
            }
            const membership =
              yield* sql`SELECT c.task_id, t.archived FROM workspace_conversation c JOIN workspace_task t ON t.id = c.task_id WHERE c.id = ${command.conversationId}`
            if (!membership[0]) return yield* Effect.fail(safeError('not-found', 'Conversation does not exist'))
            if (membership[0].task_id !== command.taskId || membership[0].archived)
              return yield* Effect.fail(
                safeError('membership-conflict', 'Follow-up must belong to an active Task and Conversation'),
              )
            yield* sql`INSERT INTO workspace_follow_up_queue (command_id, task_id, conversation_id, payload) VALUES (${command.commandId}, ${command.taskId}, ${command.conversationId}, ${encode(command)})`
            const receipt = {
              commandId: command.commandId,
              conversationId: command.conversationId,
              acceptedAt: command.issuedAt,
              replayed: false,
            }
            yield* sql`INSERT INTO workspace_command_receipt (command_id, fingerprint, payload) VALUES (${command.commandId}, ${fingerprint(command)}, ${encode(receipt)})`
            return receipt
          }),
        )
      }),
    )

  const decodeQueuedFollowUp = Effect.fnUntraced(function* (row: Record<string, unknown>) {
    const command = yield* decodeJson(enqueueFollowUpCommandSchema)(String(row.payload))
    return yield* Schema.decodeUnknownEffect(queuedFollowUpSchema)({ ...command, position: Number(row.position) }).pipe(
      Effect.mapError(() => safeError('invalid-data', 'Stored follow-up failed validation')),
    )
  })

  const decodeReadOptions = (options: WorkspaceReadPageOptions = {}) =>
    Schema.decodeUnknownEffect(workspaceReadPageOptionsSchema)(options).pipe(
      Effect.map(options => ({ afterPosition: options.afterPosition ?? 0, limit: options.limit ?? 20 })),
      Effect.mapError(() => safeError('invalid-data', 'Workspace read cursor or limit is invalid')),
    )

  function boundedItems<A>(items: ReadonlyArray<A>, byteBudget: number, atLeastOne = false): Array<A> {
    const selected: Array<A> = []
    let bytes = 1024
    for (const item of items) {
      const size = Buffer.byteLength(encode(item), 'utf8') + 1
      if (bytes + size > byteBudget && (!atLeastOne || selected.length > 0)) break
      selected.push(item)
      bytes += size
    }
    return selected
  }

  function readPage<A extends { readonly position: number }>(
    items: ReadonlyArray<A>,
    total: number,
    remaining: number,
  ) {
    const selected = boundedItems(items, 1536 * 1024, true)
    const truncated = remaining > selected.length
    return {
      items: selected,
      total,
      truncated,
      nextAfterPosition: truncated ? (selected[selected.length - 1]?.position ?? null) : null,
    }
  }

  const listQueuedFollowUps: WorkspaceStore['Service']['listQueuedFollowUps'] = (conversationId, options) =>
    guard(
      Effect.gen(function* () {
        const { afterPosition, limit } = yield* decodeReadOptions(options)
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const counts =
              yield* sql`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN position > ${afterPosition} THEN 1 ELSE 0 END), 0) AS remaining FROM workspace_follow_up_queue WHERE conversation_id = ${conversationId}`
            const rows =
              yield* sql`SELECT position, payload FROM workspace_follow_up_queue WHERE conversation_id = ${conversationId} AND position > ${afterPosition} ORDER BY position LIMIT ${limit}`
            const items = yield* Effect.forEach(rows, decodeQueuedFollowUp)
            return readPage(items, Number(counts[0]?.total ?? 0), Number(counts[0]?.remaining ?? 0))
          }),
        )
      }),
    )

  const listRequestResponses: WorkspaceStore['Service']['listRequestResponses'] = (taskId, options) =>
    guard(
      Effect.gen(function* () {
        const { afterPosition, limit } = yield* decodeReadOptions(options)
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const counts =
              yield* sql`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN i.rowid > ${afterPosition} THEN 1 ELSE 0 END), 0) AS remaining FROM workspace_request_response_intent i JOIN workspace_agent_run r ON r.id = i.run_id WHERE r.task_id = ${taskId}`
            const rows =
              yield* sql`SELECT i.rowid AS position, i.payload FROM workspace_request_response_intent i JOIN workspace_agent_run r ON r.id = i.run_id WHERE r.task_id = ${taskId} AND i.rowid > ${afterPosition} ORDER BY i.rowid LIMIT ${limit}`
            const items = yield* Effect.forEach(rows, row =>
              Effect.gen(function* () {
                const intent = yield* decodeJson(requestResponseIntentSchema)(String(row.payload))
                return yield* Schema.decodeUnknownEffect(requestResponseHistoryItemSchema)({
                  ...intent,
                  position: Number(row.position),
                }).pipe(Effect.mapError(() => safeError('invalid-data', 'Stored response cursor failed validation')))
              }),
            )
            return readPage(items, Number(counts[0]?.total ?? 0), Number(counts[0]?.remaining ?? 0))
          }),
        )
      }),
    )

  const listSteerIntents: WorkspaceStore['Service']['listSteerIntents'] = (taskId, options) =>
    guard(
      Effect.gen(function* () {
        const { afterPosition, limit } = yield* decodeReadOptions(options)
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const counts =
              yield* sql`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN i.rowid > ${afterPosition} THEN 1 ELSE 0 END), 0) AS remaining FROM workspace_steer_intent i JOIN workspace_agent_run r ON r.id = i.run_id WHERE r.task_id = ${taskId}`
            const rows =
              yield* sql`SELECT i.rowid AS position, i.payload FROM workspace_steer_intent i JOIN workspace_agent_run r ON r.id = i.run_id WHERE r.task_id = ${taskId} AND i.rowid > ${afterPosition} ORDER BY i.rowid LIMIT ${limit}`
            const items = yield* Effect.forEach(rows, row =>
              Effect.gen(function* () {
                const intent = yield* decodeJson(steerIntentSchema)(String(row.payload))
                return yield* Schema.decodeUnknownEffect(steerHistoryItemSchema)({
                  ...intent,
                  position: Number(row.position),
                }).pipe(Effect.mapError(() => safeError('invalid-data', 'Stored steering cursor failed validation')))
              }),
            )
            return readPage(items, Number(counts[0]?.total ?? 0), Number(counts[0]?.remaining ?? 0))
          }),
        )
      }),
    )

  const cancelQueuedFollowUp: WorkspaceStore['Service']['cancelQueuedFollowUp'] = (conversationId, commandId) =>
    guard(
      sql`DELETE FROM workspace_follow_up_queue WHERE conversation_id = ${conversationId} AND command_id = ${commandId}`.pipe(
        Effect.asVoid,
      ),
    )

  // Beginning the Run in the dequeue transaction prevents loss or double promotion after a crash.
  const promoteNextFollowUp: WorkspaceStore['Service']['promoteNextFollowUp'] = (conversationId, command) =>
    guard(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(beginRunCommandSchema)(command).pipe(
          Effect.mapError(() => safeError('invalid-data', 'Promotion Run command is invalid')),
        )
        if (command.conversationId !== conversationId)
          return yield* Effect.fail(safeError('membership-conflict', 'Promotion Conversation does not match the Run'))
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const active =
              yield* sql`SELECT r.id FROM workspace_agent_run r JOIN workspace_dispatch_intent i ON i.run_id = r.id WHERE i.conversation_id = ${conversationId} AND r.status NOT IN ('completed', 'failed', 'interrupted') LIMIT 1`
            if (active.length > 0) return null
            const head =
              yield* sql`SELECT position, payload FROM workspace_follow_up_queue WHERE conversation_id = ${conversationId} ORDER BY position LIMIT 1`
            if (!head[0]) return null
            const followUpCommand = yield* decodeJson(enqueueFollowUpCommandSchema)(String(head[0].payload))
            if (followUpCommand.taskId !== command.taskId)
              return yield* Effect.fail(
                safeError('membership-conflict', 'Promotion Task does not match queued follow-up'),
              )
            const followUp = { ...followUpCommand, position: Number(head[0].position) }
            const receipt = yield* beginRun({
              ...command,
              prompt: followUp.prompt,
              driverId: followUp.driverId ?? command.driverId,
              connectionId: followUp.connectionId ?? command.connectionId,
              modelId: followUp.modelId === undefined ? command.modelId : followUp.modelId,
              modeId: followUp.modeId === undefined ? command.modeId : followUp.modeId,
            })
            if (receipt.replayed)
              return yield* Effect.fail(safeError('command-conflict', 'Promotion requires a new Run command'))
            yield* sql`DELETE FROM workspace_follow_up_queue WHERE position = ${followUp.position}`
            return { followUp, receipt }
          }),
        )
      }),
    )

  const recoverWorker = (replacedEpoch: number, recoveredAt: string) =>
    guard(
      Effect.gen(function* () {
        yield* decodeWorkerEpoch(replacedEpoch)
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`UPDATE workspace_worker_epoch SET retired_epoch = MAX(retired_epoch, ${replacedEpoch}) WHERE singleton = 1`
            const responseRows = yield* sql`
              SELECT i.run_id, i.request_id, i.payload, r.payload AS run_payload
              FROM workspace_request_response_intent i JOIN workspace_agent_run r ON r.id = i.run_id
              WHERE i.state = 'pending' AND json_extract(i.payload, '$.ownerEpoch') = ${replacedEpoch}
            `
            for (const row of responseRows) {
              const intent = yield* decodeJson(requestResponseIntentSchema)(String(row.payload))
              const run = yield* decodeRun(String(row.run_payload))
              const recovered = {
                ...intent,
                state: 'uncertain',
                delivery: { outcome: 'uncertain' },
                recoveryReason: 'worker-replaced',
              }
              yield* sql`UPDATE workspace_request_response_intent SET state = 'uncertain', payload = ${encode(recovered)} WHERE run_id = ${row.run_id} AND request_id = ${row.request_id}`
              yield* appendEvent(run, 'requestResponseSettled', recoveredAt, {
                requestId: row.request_id,
                outcome: 'uncertain',
                reason: 'worker-replaced',
              })
            }
            const steerRows = yield* sql`
              SELECT i.command_id, i.payload, r.payload AS run_payload
              FROM workspace_steer_intent i JOIN workspace_agent_run r ON r.id = i.run_id
              WHERE i.state = 'pending' AND json_extract(i.payload, '$.ownerEpoch') = ${replacedEpoch}
            `
            for (const row of steerRows) {
              const intent = yield* decodeJson(steerIntentSchema)(String(row.payload))
              const run = yield* decodeRun(String(row.run_payload))
              const recovered = {
                ...intent,
                state: 'uncertain',
                delivery: { outcome: 'uncertain' },
                recoveryReason: 'worker-replaced',
              }
              yield* sql`UPDATE workspace_steer_intent SET state = 'uncertain', payload = ${encode(recovered)} WHERE command_id = ${row.command_id}`
              yield* appendEvent(run, 'steerSettled', recoveredAt, {
                commandId: row.command_id,
                outcome: 'uncertain',
                reason: 'worker-replaced',
              })
            }
            yield* sql`UPDATE workspace_driver_request_state SET state = 'expired' WHERE state = 'pending' AND run_id IN (SELECT run_id FROM workspace_dispatch_intent WHERE owner_epoch = ${replacedEpoch})`
            const intents =
              yield* sql`SELECT i.run_id, i.state, r.payload FROM workspace_dispatch_intent i JOIN workspace_agent_run r ON r.id = i.run_id WHERE i.owner_epoch = ${replacedEpoch} AND i.state IN ('claimed', 'accepted')`
            let recovered = 0
            for (const row of intents as Array<Record<string, unknown>>) {
              const current = yield* decodeRun(String(row.payload))
              if (current.status === 'completed' || current.status === 'failed' || current.status === 'interrupted') {
                yield* sql`UPDATE workspace_dispatch_intent SET state = 'settled' WHERE run_id = ${String(row.run_id)} AND owner_epoch = ${replacedEpoch}`
                continue
              }
              const status = row.state === 'claimed' ? 'uncertain' : 'recoveryRequired'
              const run = yield* transition(current, status, recoveredAt)
              yield* persistRun(run)
              yield* sql`UPDATE workspace_dispatch_intent SET state = 'recoveryRequired' WHERE run_id = ${String(row.run_id)} AND owner_epoch = ${replacedEpoch}`
              yield* appendEvent(run, row.state === 'claimed' ? 'runUncertain' : 'runRecoveryRequired', recoveredAt, {
                replacedEpoch,
              })
              recovered += 1
            }
            return recovered
          }),
        )
      }),
    )

  const pageEvents = (afterSequence: number, limit: number) =>
    guard(
      Effect.gen(function* () {
        if (
          !Number.isInteger(afterSequence) ||
          afterSequence < 0 ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 500
        ) {
          return yield* Effect.fail(safeError('invalid-data', 'Event cursor or page limit is invalid'))
        }
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const high = yield* sql`SELECT COALESCE(MAX(sequence), 0) AS high FROM workspace_execution_event`
            const rows =
              yield* sql`SELECT sequence, schema_version, kind, run_id, task_id, generation, occurred_at, payload FROM workspace_execution_event WHERE sequence > ${afterSequence} AND sequence <= ${Number(high[0]?.high ?? 0)} ORDER BY sequence LIMIT ${limit}`
            const events = yield* Effect.forEach(rows as Array<Record<string, unknown>>, row =>
              Effect.gen(function* () {
                const data = yield* decodeJson(Schema.Record(Schema.String, Schema.Unknown))(String(row.payload))
                return yield* Schema.decodeUnknownEffect(workspaceExecutionEventSchema)({
                  sequence: Number(row.sequence),
                  schemaVersion: Number(row.schema_version),
                  kind: row.kind,
                  runId: row.run_id,
                  taskId: row.task_id,
                  generation: Number(row.generation),
                  occurredAt: row.occurred_at,
                  data,
                })
              }).pipe(Effect.mapError(() => safeError('invalid-data', 'Stored workspace event failed validation'))),
            )
            return { events, highWatermark: Number(high[0]?.high ?? 0) }
          }),
        )
      }),
    )

  const readTaskSnapshot = (taskId: Parameters<WorkspaceStore['Service']['readTaskSnapshot']>[0], runLimit: number) =>
    guard(
      Effect.gen(function* () {
        if (!Number.isInteger(runLimit) || runLimit < 1 || runLimit > 500)
          return yield* Effect.fail(safeError('invalid-data', 'Snapshot page limit is invalid'))
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows =
              yield* sql`SELECT id, project_id, payload FROM workspace_task WHERE id = ${taskId} AND archived = 0`
            if (!rows[0]) return yield* Effect.fail(safeError('not-found', 'Task does not exist'))
            const taskRow = rows[0] as Record<string, unknown>
            const taskPayload = yield* decodeJson(
              Schema.Struct({
                id: taskIdSchema,
                projectId: projectIdSchema,
                title: Schema.String,
                status: Schema.String,
              }),
            )(String(taskRow.payload))
            const high = yield* sql`SELECT COALESCE(MAX(sequence), 0) AS high FROM workspace_execution_event`
            const runRows =
              yield* sql`SELECT payload FROM workspace_agent_run WHERE task_id = ${taskId} ORDER BY submitted_at DESC, id DESC LIMIT ${runLimit}`
            const runs = yield* Effect.forEach(runRows as Array<{ payload: unknown }>, row =>
              decodeRun(String(row.payload)),
            )
            const deliveryLimit = Math.min(runLimit, 50)
            const responseCounts =
              yield* sql`SELECT COUNT(*) AS total, COALESCE(SUM(i.state = 'pending'), 0) AS pending, COALESCE(SUM(i.state = 'uncertain'), 0) AS uncertain FROM workspace_request_response_intent i JOIN workspace_agent_run r ON r.id = i.run_id WHERE r.task_id = ${taskId}`
            const responseRows =
              yield* sql`SELECT i.payload FROM workspace_request_response_intent i JOIN workspace_agent_run r ON r.id = i.run_id WHERE r.task_id = ${taskId} ORDER BY CASE i.state WHEN 'pending' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END, i.rowid DESC LIMIT ${deliveryLimit}`
            const responses = yield* Effect.forEach(responseRows, row =>
              decodeJson(requestResponseIntentSchema)(String(row.payload)),
            )
            // Full delivery bodies remain available through the cursor-paged history reads.
            const requestResponses = boundedItems(
              responses.map(intent => {
                if (Buffer.byteLength(encode(intent), 'utf8') <= 8192) return intent
                const { decision, ...preview } = intent
                return { ...preview, decisionKind: decision.kind, payloadTruncated: true }
              }),
              512 * 1024,
            )
            const steerCounts =
              yield* sql`SELECT COUNT(*) AS total, COALESCE(SUM(i.state = 'pending'), 0) AS pending, COALESCE(SUM(i.state = 'uncertain'), 0) AS uncertain FROM workspace_steer_intent i JOIN workspace_agent_run r ON r.id = i.run_id WHERE r.task_id = ${taskId}`
            const steerRows =
              yield* sql`SELECT i.payload FROM workspace_steer_intent i JOIN workspace_agent_run r ON r.id = i.run_id WHERE r.task_id = ${taskId} ORDER BY CASE i.state WHEN 'pending' THEN 0 WHEN 'uncertain' THEN 1 ELSE 2 END, i.rowid DESC LIMIT ${deliveryLimit}`
            const steers = yield* Effect.forEach(steerRows, row => decodeJson(steerIntentSchema)(String(row.payload)))
            const steerIntents = boundedItems(
              steers.map(intent => {
                if (Buffer.byteLength(encode(intent), 'utf8') <= 8192) return intent
                const { message, ...preview } = intent
                return { ...preview, messagePreview: message.slice(0, 512), payloadTruncated: true }
              }),
              512 * 1024,
            )
            const queueCounts =
              yield* sql`SELECT COUNT(*) AS total FROM workspace_follow_up_queue WHERE task_id = ${taskId}`
            const queuedRows =
              yield* sql`SELECT position, payload FROM workspace_follow_up_queue WHERE task_id = ${taskId} ORDER BY position LIMIT ${deliveryLimit}`
            const queue = yield* Effect.forEach(queuedRows, decodeQueuedFollowUp)
            const queuedFollowUps = boundedItems(
              queue.map(({ commandId, taskId, conversationId, issuedAt, position, prompt }) => ({
                commandId,
                taskId,
                conversationId,
                issuedAt,
                position,
                promptByteLength: Buffer.byteLength(prompt, 'utf8'),
                promptPreview: prompt.slice(0, 512),
              })),
              512 * 1024,
            )
            const requestResponseSummary = {
              total: Number(responseCounts[0]?.total ?? 0),
              pendingCount: Number(responseCounts[0]?.pending ?? 0),
              uncertainCount: Number(responseCounts[0]?.uncertain ?? 0),
              truncated:
                Number(responseCounts[0]?.total ?? 0) > requestResponses.length ||
                requestResponses.some(intent => 'payloadTruncated' in intent),
            }
            const steerIntentSummary = {
              total: Number(steerCounts[0]?.total ?? 0),
              pendingCount: Number(steerCounts[0]?.pending ?? 0),
              uncertainCount: Number(steerCounts[0]?.uncertain ?? 0),
              truncated:
                Number(steerCounts[0]?.total ?? 0) > steerIntents.length ||
                steerIntents.some(intent => 'payloadTruncated' in intent),
            }
            const queuedFollowUpSummary = {
              total: Number(queueCounts[0]?.total ?? 0),
              truncated: Number(queueCounts[0]?.total ?? 0) > queuedFollowUps.length,
            }
            return {
              task: taskPayload,
              runs,
              requestResponses,
              steerIntents,
              queuedFollowUps,
              requestResponseSummary,
              steerIntentSummary,
              queuedFollowUpSummary,
              highWatermark: Number(high[0]?.high ?? 0),
            }
          }),
        )
      }),
    )

  return WorkspaceStore.of({
    registerProject,
    createTask,
    beginRun,
    claimDispatch,
    acknowledgeDispatch,
    recordDriverEvent,
    failDispatch,
    requestInterrupt,
    recordRequestResponse,
    settleRequestResponse,
    recordSteer,
    settleSteer,
    enqueueFollowUp,
    cancelQueuedFollowUp,
    listQueuedFollowUps,
    listRequestResponses,
    listSteerIntents,
    promoteNextFollowUp,
    recoverWorker,
    pageEvents,
    readTaskSnapshot,
  })
})

export const WorkspaceStoreLive = (options: { readonly filename: string }) => {
  const sqlLayer = Sqlite.SqliteClient.layer({ filename: options.filename })
  return Layer.effect(WorkspaceStore, makeService).pipe(Layer.provide(sqlLayer))
}
