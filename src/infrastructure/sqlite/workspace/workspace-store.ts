import { createHash } from 'node:crypto'

import * as Sqlite from '@effect/sql-sqlite-node'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Predicate from 'effect/Predicate'
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
import { agentDriverEventSchema, agentRunSchema } from '@/shared/schemas/execution.js'
import {
  type Project,
  projectIdSchema,
  projectSchema,
  type Task,
  taskIdSchema,
  taskSchema,
  type WorkspaceCheckout,
  workspaceCheckoutSchema,
} from '@/shared/schemas/workspace.js'
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
  nativeSessionBindingSchema,
  ownerEpochAcquisitionSchema,
  promotedFollowUpSchema,
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
  WORKSPACE_STORE_READ_BYTE_CAPACITY,
  workspaceCheckoutPageOptionsSchema,
  workspaceConversationMessageSchema,
  type WorkspaceConversationPageItem,
  workspaceConversationPageItemSchema,
  workspaceConversationPageSchema,
  type WorkspaceConversationRead,
  workspaceConversationReadSchema,
  type WorkspaceDeliveryOutcome,
  workspaceEntityPageOptionsSchema,
  workspaceEventPageOptionsSchema,
  type WorkspaceExecutionEvent,
  workspaceExecutionEventSchema,
  workspaceNativeAgentSessionSchema,
  workspacePayloadPageOptionsSchema,
  type WorkspacePayloadReference,
  type WorkspacePendingRuntimeRequest,
  workspacePendingRuntimeRequestPageOptionsSchema,
  workspacePendingRuntimeRequestPageSchema,
  workspacePendingRuntimeRequestSchema,
  workspaceProjectDetailSchema,
  workspaceProjectReadPageSchema,
  type WorkspaceReadPageOptions,
  workspaceReadPageOptionsSchema,
  WorkspaceStoreError,
  workspaceTaskDetailSchema,
  workspaceTaskReadPageSchema,
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
  {
    version: 7,
    name: 'persist_workspace_owner_epoch_counter',
    up: executeSqliteScript(`
      ALTER TABLE workspace_worker_epoch ADD COLUMN allocated_epoch INTEGER NOT NULL DEFAULT 0 CHECK (allocated_epoch >= 0);
      UPDATE workspace_worker_epoch SET allocated_epoch = MAX(
        retired_epoch,
        COALESCE((SELECT MAX(owner_epoch) FROM workspace_dispatch_intent), 0),
        COALESCE((SELECT MAX(CAST(json_extract(payload, '$.ownerEpoch') AS INTEGER)) FROM workspace_request_response_intent WHERE json_valid(payload)), 0),
        COALESCE((SELECT MAX(CAST(json_extract(payload, '$.ownerEpoch') AS INTEGER)) FROM workspace_steer_intent WHERE json_valid(payload)), 0)
      ) WHERE singleton = 1;
    `),
  },
  {
    version: 8,
    name: 'persist_workspace_promotion_receipts',
    up: executeSqliteScript(`
      ALTER TABLE workspace_command_receipt ADD COLUMN promotion_payload TEXT;
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

const receiptServerFields = {
  beginRun: ['issuedAt', 'occurredAt', 'ownerEpoch', 'runId', 'provisionalAgentSessionId'],
  promoteFollowUp: ['issuedAt', 'occurredAt', 'ownerEpoch', 'runId', 'provisionalAgentSessionId'],
  enqueueFollowUp: ['issuedAt'],
  recordRequestResponse: ['issuedAt', 'occurredAt', 'ownerEpoch'],
  recordSteer: ['issuedAt', 'occurredAt', 'ownerEpoch'],
} as const

type ReceiptKind = keyof typeof receiptServerFields

const receiptFingerprint = (kind: ReceiptKind, command: object): string => {
  const excluded: ReadonlyArray<string> = receiptServerFields[kind]
  const intent = Object.fromEntries(Object.entries(command).filter(([field]) => !excluded.includes(field)))
  return `v2:${fingerprint({ kind, intent })}`
}

const matchesReceipt = (saved: string, kind: ReceiptKind, command: object): boolean =>
  saved === (saved.startsWith('v2:') ? receiptFingerprint(kind, command) : fingerprint(command))

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
            const commandFingerprint = receiptFingerprint('beginRun', command)
            const prior =
              yield* sql`SELECT fingerprint, payload FROM workspace_command_receipt WHERE command_id = ${command.commandId}`
            if (prior[0]) {
              if (!matchesReceipt(String(prior[0].fingerprint), 'beginRun', command))
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
            const worker =
              yield* sql`SELECT CAST(retired_epoch AS TEXT) AS retired_epoch, CAST(allocated_epoch AS TEXT) AS allocated_epoch FROM workspace_worker_epoch WHERE singleton = 1`
            const retiredEpoch = Number(worker[0]?.retired_epoch)
            const allocatedEpoch = Number(worker[0]?.allocated_epoch)
            if (
              !Number.isSafeInteger(retiredEpoch) ||
              retiredEpoch < 0 ||
              !Number.isSafeInteger(allocatedEpoch) ||
              allocatedEpoch < 0
            )
              return yield* Effect.fail(safeError('invalid-data', 'Stored workspace owner epoch is invalid'))
            // Keep the old caller-owned path only for databases that have never allocated an epoch here.
            if (ownerEpoch <= retiredEpoch || (allocatedEpoch > 0 && ownerEpoch !== allocatedEpoch))
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

  const associateNativeSession = Effect.fnUntraced(function* (
    runId: Parameters<WorkspaceStore['Service']['bindNativeSession']>[0],
    binding: Parameters<WorkspaceStore['Service']['bindNativeSession']>[1],
  ) {
    yield* Schema.decodeUnknownEffect(nativeSessionBindingSchema)(binding).pipe(
      Effect.mapError(() => safeError('invalid-data', 'Native session binding is invalid')),
    )
    const { row, run } = yield* loadOwnedDispatch(runId, binding.ownerEpoch)
    if (row.state !== 'claimed' && row.state !== 'accepted')
      return yield* Effect.fail(safeError('invalid-transition', 'Native session cannot bind to this dispatch'))
    if (binding.generation !== run.generation || binding.generation !== Number(row.generation))
      return yield* Effect.fail(safeError('membership-conflict', 'Native session generation does not match the Run'))
    if (row.requested_native_session_id && row.requested_native_session_id !== binding.nativeSessionId)
      return yield* Effect.fail(safeError('membership-conflict', 'Native session does not match the requested session'))
    if (row.native_session_id && row.native_session_id !== binding.nativeSessionId)
      return yield* Effect.fail(safeError('membership-conflict', 'Native session identity changed during binding'))

    const existing = yield* sql`
      SELECT id, task_id, conversation_id, checkout_id, generation, driver_id, connection_id
      FROM workspace_agent_session
      WHERE driver_id = ${row.driver_id} AND connection_id = ${row.connection_id}
        AND native_session_id = ${binding.nativeSessionId}
    `
    let sessionId = String(row.provisional_session_id)
    if (existing[0]) {
      const session = existing[0] as Record<string, unknown>
      if (
        session.task_id !== row.task_id ||
        session.conversation_id !== row.conversation_id ||
        session.checkout_id !== row.checkout_id ||
        Number(session.generation) !== Number(row.generation) ||
        session.driver_id !== row.driver_id ||
        session.connection_id !== row.connection_id
      ) {
        return yield* Effect.fail(
          safeError('membership-conflict', 'Native session identity belongs to another execution context'),
        )
      }
      sessionId = String(session.id)
    } else {
      yield* sql`INSERT INTO workspace_agent_session (id, task_id, conversation_id, checkout_id, generation, driver_id, connection_id, native_session_id, status) VALUES (${row.provisional_session_id}, ${row.task_id}, ${row.conversation_id}, ${row.checkout_id}, ${Number(row.generation)}, ${row.driver_id}, ${row.connection_id}, ${binding.nativeSessionId}, 'active')`
    }
    if (run.sessionId && run.sessionId !== sessionId)
      return yield* Effect.fail(safeError('membership-conflict', 'Agent Session changed during native session binding'))
    if (!run.sessionId) {
      const associatedRun = { ...run, sessionId: sessionId as AgentRun['sessionId'] }
      yield* sql`UPDATE workspace_agent_run SET session_id = ${sessionId}, payload = ${encode(associatedRun)} WHERE id = ${runId}`
    }
    if (!row.native_session_id)
      yield* sql`UPDATE workspace_dispatch_intent SET native_session_id = ${binding.nativeSessionId} WHERE run_id = ${runId}`
    return { row, run: run.sessionId ? run : { ...run, sessionId: sessionId as AgentRun['sessionId'] }, sessionId }
  })

  const bindNativeSession = (
    runId: Parameters<WorkspaceStore['Service']['bindNativeSession']>[0],
    binding: Parameters<WorkspaceStore['Service']['bindNativeSession']>[1],
  ) =>
    guard(
      Effect.gen(function* () {
        return yield* sql.withTransaction(associateNativeSession(runId, binding).pipe(Effect.asVoid))
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
            const generationRows = yield* sql`SELECT generation FROM workspace_dispatch_intent WHERE run_id = ${runId}`
            const intentRows = yield* sql`
              SELECT state, owner_epoch, native_session_id, native_turn_id
              FROM workspace_dispatch_intent WHERE run_id = ${runId}
            `
            const prior = intentRows[0] as Record<string, unknown> | undefined
            if (!prior) return yield* Effect.fail(safeError('not-found', 'Dispatch intent does not exist'))
            if (
              prior.state === 'settled' &&
              Number(prior.owner_epoch) === acknowledgement.ownerEpoch &&
              prior.native_session_id === acknowledgement.nativeSessionId &&
              prior.native_turn_id === (acknowledgement.nativeTurnId ?? null)
            )
              return
            const binding = {
              ownerEpoch: acknowledgement.ownerEpoch,
              nativeSessionId: acknowledgement.nativeSessionId,
              generation: Number(generationRows[0]?.generation),
              recordedAt: acknowledgement.acknowledgedAt,
            }
            const associated = yield* associateNativeSession(runId, binding)
            if (associated.row.state === 'accepted') {
              const acceptedTurnId = associated.row.native_turn_id as string | null
              if (acceptedTurnId === (acknowledgement.nativeTurnId ?? null)) return
              return yield* Effect.fail(
                safeError('membership-conflict', 'Native acknowledgement changed after acceptance'),
              )
            }
            const current = associated.run
            if (
              (current.nativeTurnId &&
                acknowledgement.nativeTurnId &&
                current.nativeTurnId !== acknowledgement.nativeTurnId) ||
              (associated.row.native_turn_id &&
                acknowledgement.nativeTurnId &&
                associated.row.native_turn_id !== acknowledgement.nativeTurnId)
            )
              return yield* Effect.fail(
                safeError('membership-conflict', 'Native turn identity changed during acknowledgement'),
              )
            const nativeTurnId = acknowledgement.nativeTurnId ?? current.nativeTurnId ?? null
            let startedRun: AgentRun
            if (current.status === 'starting') {
              startedRun = yield* transition(current, 'running', acknowledgement.acknowledgedAt, { nativeTurnId })
            } else if (current.status === 'interruptRequested' && !current.startedAt) {
              const started = yield* transition(
                { ...current, status: 'starting' },
                'running',
                acknowledgement.acknowledgedAt,
                { nativeTurnId },
              )
              startedRun = { ...started, status: 'interruptRequested' }
            } else if (
              current.status === 'running' ||
              current.status === 'awaitingInput' ||
              current.status === 'interruptRequested'
            ) {
              startedRun = { ...current, nativeTurnId }
            } else {
              return yield* Effect.fail(
                safeError('invalid-transition', 'Native acknowledgement is not valid for this Run'),
              )
            }
            yield* persistRun(startedRun)
            yield* sql`UPDATE workspace_dispatch_intent SET state = 'accepted', native_turn_id = ${nativeTurnId} WHERE run_id = ${runId}`
            yield* appendEvent(startedRun, 'runStarted', acknowledgement.acknowledgedAt, { nativeTurnId })
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

  const decodeEventData = (kind: unknown, payload: string) =>
    kind === 'driverEvent'
      ? decodeJson(
          Schema.Struct({ eventId: recordDriverEventCommandSchema.fields.eventId, event: agentDriverEventSchema }),
        )(payload)
      : decodeJson(Schema.Record(Schema.String, Schema.Unknown))(payload)

  const decodeStoredEvent = (row: Record<string, unknown>) =>
    Effect.gen(function* () {
      const data = yield* decodeEventData(row.kind, String(row.payload))
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
            const boundButUnaccepted = row.state === 'claimed' && row.native_session_id !== null
            if (row.state !== 'accepted' && !boundButUnaccepted) {
              if (run.status === 'completed' || run.status === 'failed' || run.status === 'interrupted')
                return yield* Effect.fail(
                  safeError('invalid-transition', 'Terminal Run cannot accept another driver event'),
                )
              return yield* Effect.fail(safeError('stale-epoch', 'Driver event dispatch is no longer accepted'))
            }

            const event = command.event as AgentDriverEvent
            if (
              row.state === 'claimed' &&
              (event.kind === 'turnCompleted' || event.kind === 'turnInterrupted' || event.kind === 'turnFailed')
            )
              return yield* Effect.fail(
                safeError('invalid-transition', 'Terminal driver event arrived before native submission was accepted'),
              )
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
              row.state === 'claimed'
                ? undefined
                : event.kind === 'turnStarted' ||
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
                else if (run.status === 'starting') {
                  const started = yield* transition(run, 'running', command.occurredAt)
                  updatedRun = yield* transition(started, 'awaitingInput', command.occurredAt)
                } else if (run.status !== 'awaitingInput' && run.status !== 'interruptRequested')
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
            const storedEvent =
              row.state === 'claimed' && suppliedTurnId !== undefined
                ? { ...event, nativeTurnId: undefined }
                : command.event
            const data = { eventId: command.eventId, event: storedEvent }
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

  const replayReceipt = Effect.fnUntraced(function* (kind: ReceiptKind, command: { readonly commandId: string }) {
    const prior =
      yield* sql`SELECT fingerprint, payload FROM workspace_command_receipt WHERE command_id = ${command.commandId}`
    if (!prior[0]) return undefined
    if (!matchesReceipt(String(prior[0].fingerprint), kind, command))
      return yield* Effect.fail(safeError('command-conflict', 'Command ID was already used with different input'))
    const receipt = yield* decodeJson(commandReceiptSchema)(String(prior[0].payload))
    return { ...receipt, replayed: true }
  })

  const saveReceipt = Effect.fnUntraced(function* (
    kind: ReceiptKind,
    command: {
      readonly commandId: string
      readonly runId: AgentRun['id']
      readonly issuedAt: string
    },
  ) {
    const receipt: CommandReceipt = {
      commandId: command.commandId,
      runId: command.runId,
      acceptedAt: command.issuedAt,
      replayed: false,
    }
    yield* sql`INSERT INTO workspace_command_receipt (command_id, fingerprint, payload) VALUES (${command.commandId}, ${receiptFingerprint(kind, command)}, ${encode(receipt)})`
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
            const replay = yield* replayReceipt('recordRequestResponse', command)
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
            return yield* saveReceipt('recordRequestResponse', command)
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
            const replay = yield* replayReceipt('recordSteer', command)
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
            return yield* saveReceipt('recordSteer', command)
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
              if (!matchesReceipt(String(prior[0].fingerprint), 'enqueueFollowUp', command))
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
            yield* sql`INSERT INTO workspace_command_receipt (command_id, fingerprint, payload) VALUES (${command.commandId}, ${receiptFingerprint('enqueueFollowUp', command)}, ${encode(receipt)})`
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
            const prior =
              yield* sql`SELECT fingerprint, promotion_payload FROM workspace_command_receipt WHERE command_id = ${command.commandId}`
            if (prior[0]) {
              if (
                !matchesReceipt(String(prior[0].fingerprint), 'promoteFollowUp', command) ||
                prior[0].promotion_payload == null
              )
                return yield* Effect.fail(
                  safeError('command-conflict', 'Command ID was already used with different input'),
                )
              const promoted = yield* decodeJson(promotedFollowUpSchema)(String(prior[0].promotion_payload))
              return { ...promoted, receipt: { ...promoted.receipt, replayed: true } }
            }
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
            const promoted = { followUp, receipt }
            yield* sql`UPDATE workspace_command_receipt SET fingerprint = ${receiptFingerprint('promoteFollowUp', command)}, promotion_payload = ${encode(promoted)} WHERE command_id = ${command.commandId}`
            yield* sql`DELETE FROM workspace_follow_up_queue WHERE position = ${followUp.position}`
            return promoted
          }),
        )
      }),
    )

  const recoverWorkerInTransaction = Effect.fnUntraced(function* (replacedEpoch: number, recoveredAt: string) {
    yield* sql`UPDATE workspace_worker_epoch SET retired_epoch = MAX(retired_epoch, ${replacedEpoch}) WHERE singleton = 1`
    const responseRows = yield* sql`
              SELECT i.run_id, i.request_id, i.payload, r.payload AS run_payload
              FROM workspace_request_response_intent i JOIN workspace_agent_run r ON r.id = i.run_id
              WHERE i.state = 'pending' AND json_extract(i.payload, '$.ownerEpoch') <= ${replacedEpoch}
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
              WHERE i.state = 'pending' AND json_extract(i.payload, '$.ownerEpoch') <= ${replacedEpoch}
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
    yield* sql`UPDATE workspace_driver_request_state SET state = 'expired' WHERE state = 'pending' AND run_id IN (SELECT run_id FROM workspace_dispatch_intent WHERE owner_epoch <= ${replacedEpoch})`
    const intents =
      yield* sql`SELECT i.run_id, i.state, i.owner_epoch, r.payload FROM workspace_dispatch_intent i JOIN workspace_agent_run r ON r.id = i.run_id WHERE i.owner_epoch <= ${replacedEpoch} AND i.state IN ('claimed', 'accepted')`
    let recovered = 0
    for (const row of intents as Array<Record<string, unknown>>) {
      const current = yield* decodeRun(String(row.payload))
      if (current.status === 'completed' || current.status === 'failed' || current.status === 'interrupted') {
        yield* sql`UPDATE workspace_dispatch_intent SET state = 'settled' WHERE run_id = ${String(row.run_id)} AND owner_epoch = ${Number(row.owner_epoch)}`
        continue
      }
      const status = row.state === 'claimed' ? 'uncertain' : 'recoveryRequired'
      const run = yield* transition(current, status, recoveredAt)
      yield* persistRun(run)
      yield* sql`UPDATE workspace_dispatch_intent SET state = 'recoveryRequired' WHERE run_id = ${String(row.run_id)} AND owner_epoch = ${Number(row.owner_epoch)}`
      yield* appendEvent(run, row.state === 'claimed' ? 'runUncertain' : 'runRecoveryRequired', recoveredAt, {
        replacedEpoch,
      })
      recovered += 1
    }
    return recovered
  })

  const recoverWorker = (replacedEpoch: number, recoveredAt: string) =>
    guard(
      Effect.gen(function* () {
        yield* decodeWorkerEpoch(replacedEpoch)
        return yield* sql.withTransaction(recoverWorkerInTransaction(replacedEpoch, recoveredAt))
      }),
    )

  const acquireOwnerEpoch = Effect.fn('WorkspaceStore.acquireOwnerEpoch')(function* (recoveredAt: string) {
    return yield* guard(
      Effect.gen(function* () {
        if (!Schema.is(timestampSchema)(recoveredAt))
          return yield* Effect.fail(safeError('invalid-data', 'Owner epoch recovery timestamp is invalid'))
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql`
              SELECT CAST(allocated_epoch AS TEXT) AS allocated_epoch,
                CAST(retired_epoch AS TEXT) AS retired_epoch,
                CAST(MAX(
                  COALESCE((SELECT MAX(owner_epoch) FROM workspace_dispatch_intent), 0),
                  COALESCE((SELECT MAX(CAST(json_extract(payload, '$.ownerEpoch') AS INTEGER)) FROM workspace_request_response_intent WHERE json_valid(payload)), 0),
                  COALESCE((SELECT MAX(CAST(json_extract(payload, '$.ownerEpoch') AS INTEGER)) FROM workspace_steer_intent WHERE json_valid(payload)), 0)
                ) AS TEXT) AS persisted_epoch
              FROM workspace_worker_epoch WHERE singleton = 1
            `
            const allocatedEpoch = Number(rows[0]?.allocated_epoch)
            const retiredEpoch = Number(rows[0]?.retired_epoch)
            const persistedEpoch = Number(rows[0]?.persisted_epoch)
            const safeEpochValue = Schema.Number.check(
              Schema.isInt(),
              Schema.isGreaterThanOrEqualTo(0),
              Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
            )
            for (const epoch of [allocatedEpoch, retiredEpoch, persistedEpoch])
              yield* Schema.decodeUnknownEffect(safeEpochValue)(epoch).pipe(
                Effect.mapError(() => safeError('invalid-data', 'Stored workspace owner epoch is invalid')),
              )
            const previousEpoch = Math.max(allocatedEpoch, retiredEpoch, persistedEpoch)
            if (previousEpoch >= Number.MAX_SAFE_INTEGER)
              return yield* Effect.fail(safeError('invalid-data', 'Stored workspace owner epoch is invalid'))
            const ownerEpoch = previousEpoch + 1
            yield* sql`UPDATE workspace_worker_epoch SET allocated_epoch = ${ownerEpoch} WHERE singleton = 1`
            const recoveredCount =
              previousEpoch === 0 ? 0 : yield* recoverWorkerInTransaction(previousEpoch, recoveredAt)
            return yield* Schema.decodeUnknownEffect(ownerEpochAcquisitionSchema)({ ownerEpoch, recoveredCount }).pipe(
              Effect.mapError(() => safeError('invalid-data', 'Workspace owner epoch acquisition failed validation')),
            )
          }),
        )
      }),
    )
  })

  const requireTask = Effect.fnUntraced(function* (taskId: string) {
    const rows = yield* sql`SELECT id, project_id, payload FROM workspace_task WHERE id = ${taskId} AND archived = 0`
    if (!rows[0]) return yield* Effect.fail(safeError('not-found', 'Task does not exist'))
    const task = yield* decodeJson(taskSchema)(String(rows[0].payload))
    if (task.id !== taskId || task.projectId !== rows[0].project_id)
      return yield* Effect.fail(safeError('invalid-data', 'Stored Task identity failed validation'))
    return task
  })

  function preview(value: unknown, depth = 0): unknown {
    if (Predicate.isString(value)) return value.slice(0, 256)
    if (Array.isArray(value)) return depth < 6 ? value.slice(0, 4).map(item => preview(item, depth + 1)) : []
    if (Predicate.isObject(value))
      return depth < 6
        ? Object.fromEntries(
            Object.entries(value)
              .slice(0, 16)
              .map(([key, item]) => [key, preview(item, depth + 1)]),
          )
        : {}
    return value
  }

  function summarize<A extends object>(
    value: A,
    kind: WorkspacePayloadReference['kind'],
    id: string,
    byteLimit = 1024 * 1024,
  ): A & {
    readonly payloadTruncated?: true
    readonly payloadRef?: WorkspacePayloadReference
  } {
    if (Buffer.byteLength(encode(value), 'utf8') <= byteLimit) return value
    return {
      ...(preview(value) as A),
      ...Object.fromEntries(
        Object.entries(value).filter(([key]) =>
          ['id', 'projectId', 'taskId', 'runId', 'conversationId', 'checkoutId'].includes(key),
        ),
      ),
      payloadTruncated: true,
      payloadRef: { kind, id, digest: fingerprint(value) },
    }
  }

  const decodeNativeSession = (row: Record<string, unknown>) =>
    Schema.decodeUnknownEffect(workspaceNativeAgentSessionSchema)({
      id: row.id,
      taskId: row.task_id,
      conversationId: row.conversation_id,
      checkoutId: row.checkout_id,
      driverId: row.driver_id,
      connectionId: row.connection_id,
      nativeSessionId: row.native_session_id,
      generation: Number(row.generation),
      status: row.status,
    }).pipe(Effect.mapError(() => safeError('invalid-data', 'Stored native Agent Session failed validation')))

  const readWorkspacePayload: WorkspaceStore['Service']['readWorkspacePayload'] = (reference, afterOffset, limit) =>
    guard(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(workspacePayloadPageOptionsSchema)({ reference, afterOffset, limit }).pipe(
          Effect.mapError(() => safeError('invalid-data', 'Workspace payload reference or cursor is invalid')),
        )
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            let value: unknown
            switch (reference.kind) {
              case 'event': {
                const rows =
                  yield* sql`SELECT sequence, schema_version, kind, run_id, task_id, generation, occurred_at, payload FROM workspace_execution_event WHERE sequence = ${reference.id}`
                if (!rows[0]) return yield* Effect.fail(safeError('not-found', 'Workspace event does not exist'))
                value = yield* decodeStoredEvent(rows[0])
                break
              }
              case 'message': {
                const rows =
                  yield* sql`SELECT id, content, created_at FROM workspace_message WHERE id = ${reference.id} AND role = 'user'`
                if (!rows[0]) return yield* Effect.fail(safeError('not-found', 'Conversation message does not exist'))
                value = yield* Schema.decodeUnknownEffect(workspaceConversationMessageSchema)({
                  id: rows[0].id,
                  content: rows[0].content,
                  createdAt: rows[0].created_at,
                }).pipe(
                  Effect.mapError(() => safeError('invalid-data', 'Stored Conversation message failed validation')),
                )
                break
              }
              case 'agentSession': {
                const rows =
                  yield* sql`SELECT * FROM workspace_agent_session WHERE id = ${reference.id} AND native_session_id IS NOT NULL`
                if (!rows[0]) return yield* Effect.fail(safeError('not-found', 'Agent Session does not exist'))
                value = yield* decodeNativeSession(rows[0])
                break
              }
              default: {
                const tables = {
                  project: 'workspace_project',
                  checkout: 'workspace_checkout',
                  task: 'workspace_task',
                  conversation: 'workspace_conversation',
                } as const
                const rows =
                  yield* sql`SELECT id, payload FROM ${sql(tables[reference.kind])} WHERE id = ${reference.id}`
                if (!rows[0]) return yield* Effect.fail(safeError('not-found', 'Workspace entity does not exist'))
                switch (reference.kind) {
                  case 'project':
                    value = yield* decodeJson(projectSchema)(String(rows[0].payload))
                    break
                  case 'checkout':
                    value = yield* decodeJson(workspaceCheckoutSchema)(String(rows[0].payload))
                    break
                  case 'task':
                    value = yield* decodeJson(taskSchema)(String(rows[0].payload))
                    break
                  case 'conversation':
                    value = yield* decodeJson(workspaceConversationReadSchema)(String(rows[0].payload))
                    break
                }
              }
            }
            if (fingerprint(value) !== reference.digest)
              return yield* Effect.fail(safeError('invalid-data', 'Workspace payload reference is stale'))
            const json = encode(value)
            if (afterOffset > json.length)
              return yield* Effect.fail(safeError('invalid-data', 'Workspace payload cursor is invalid'))
            const end = Math.min(afterOffset + limit, json.length)
            return {
              json: json.slice(afterOffset, end),
              total: json.length,
              nextAfterOffset: end < json.length ? end : null,
              truncated: end < json.length,
            }
          }),
        )
      }),
    )

  const pageEvents: WorkspaceStore['Service']['pageEvents'] = (afterSequence, limit, throughSequence) =>
    guard(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(workspaceEventPageOptionsSchema)({
          afterSequence,
          limit,
          throughSequence,
        }).pipe(Effect.mapError(() => safeError('invalid-data', 'Event cursor or page limit is invalid')))
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const high = yield* sql`SELECT COALESCE(MAX(sequence), 0) AS high FROM workspace_execution_event`
            const latestSequence = Number(high[0]?.high ?? 0)
            if (throughSequence !== undefined && throughSequence > latestSequence)
              return yield* Effect.fail(safeError('invalid-data', 'Event high watermark is invalid'))
            const highWatermark = throughSequence ?? latestSequence
            const events: Array<WorkspaceExecutionEvent> = []
            let cursor = afterSequence
            let encodedBytes = 1024
            let hasMore = false
            for (let index = 0; index < limit; index += 1) {
              const rows =
                yield* sql`SELECT sequence, schema_version, kind, run_id, task_id, generation, occurred_at, payload FROM workspace_execution_event WHERE sequence > ${cursor} AND sequence <= ${highWatermark} ORDER BY sequence LIMIT 1`
              const row = rows[0] as Record<string, unknown> | undefined
              if (!row) break
              const storedEvent = yield* decodeStoredEvent(row)
              const event = summarize(storedEvent, 'event', String(storedEvent.sequence))
              const nextBytes = Buffer.byteLength(JSON.stringify(event), 'utf8') + 1
              if (encodedBytes + nextBytes > WORKSPACE_STORE_READ_BYTE_CAPACITY) {
                if (events.length === 0)
                  return yield* Effect.fail(
                    safeError('invalid-data', 'Stored workspace event exceeds the read page byte limit'),
                  )
                hasMore = true
                break
              }
              events.push(event)
              encodedBytes += nextBytes
              cursor = event.sequence
            }
            if (!hasMore && cursor < highWatermark) {
              const more =
                yield* sql`SELECT 1 AS found FROM workspace_execution_event WHERE sequence > ${cursor} AND sequence <= ${highWatermark} LIMIT 1`
              hasMore = more.length > 0
            }
            return { events, highWatermark, nextAfterSequence: hasMore ? cursor : null, hasMore }
          }),
        )
      }),
    )

  const decodeEntityPageOptions = (options: unknown) =>
    Schema.decodeUnknownEffect(workspaceEntityPageOptionsSchema)(options ?? {}).pipe(
      Effect.map(value => ({ afterId: value.afterId ?? '', limit: value.limit ?? 20 })),
      Effect.mapError(() => safeError('invalid-data', 'Workspace entity cursor or limit is invalid')),
    )

  const appendEntityPageItem = Effect.fnUntraced(function* <A extends { readonly id: string }>(
    items: Array<A>,
    item: A,
    total: number,
    entity: 'Project' | 'Task',
  ): Effect.fn.Return<boolean, WorkspaceStoreError> {
    const candidate = [...items, item]
    if (
      Buffer.byteLength(JSON.stringify({ items: candidate, total, nextAfterId: item.id }), 'utf8') >
      WORKSPACE_STORE_READ_BYTE_CAPACITY
    ) {
      if (items.length === 0)
        return yield* Effect.fail(safeError('invalid-data', `Stored ${entity} exceeds the read page byte limit`))
      return false
    }
    items.push(item)
    return true
  })

  const listProjects: WorkspaceStore['Service']['listProjects'] = options =>
    guard(
      Effect.gen(function* () {
        const { afterId, limit } = yield* decodeEntityPageOptions(options)
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const counts = yield* sql`SELECT COUNT(*) AS total FROM workspace_project`
            const total = Number(counts[0]?.total ?? 0)
            const items: Array<Project> = []
            let cursor = afterId
            let hasMore = false
            for (let index = 0; index < limit; index += 1) {
              const rows =
                yield* sql`SELECT id, payload FROM workspace_project WHERE id > ${cursor} ORDER BY id LIMIT 1`
              const row = rows[0]
              if (!row) break
              const project = summarize(
                yield* decodeJson(projectSchema)(String(row.payload)),
                'project',
                String(row.id),
              )
              if (project.id !== row.id)
                return yield* Effect.fail(safeError('invalid-data', 'Stored Project identity failed validation'))
              if (!(yield* appendEntityPageItem(items, project, total, 'Project'))) {
                hasMore = true
                break
              }
              cursor = project.id
            }
            if (!hasMore) {
              const more = yield* sql`SELECT 1 AS found FROM workspace_project WHERE id > ${cursor} LIMIT 1`
              hasMore = more.length > 0
            }
            return yield* Schema.decodeUnknownEffect(workspaceProjectReadPageSchema)({
              items,
              total,
              nextAfterId: hasMore ? cursor : null,
            }).pipe(Effect.mapError(() => safeError('invalid-data', 'Stored project page failed validation')))
          }),
        )
      }),
    )

  const getProject: WorkspaceStore['Service']['getProject'] = (projectId, options) =>
    guard(
      Effect.gen(function* () {
        const page = yield* Schema.decodeUnknownEffect(workspaceCheckoutPageOptionsSchema)(options ?? {}).pipe(
          Effect.map(value => ({ afterCheckoutId: value.afterCheckoutId ?? '', limit: value.limit ?? 20 })),
          Effect.mapError(() => safeError('invalid-data', 'Checkout cursor or page limit is invalid')),
        )
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const projectRows = yield* sql`SELECT id, payload FROM workspace_project WHERE id = ${projectId}`
            if (!projectRows[0]) return yield* Effect.fail(safeError('not-found', 'Project does not exist'))
            const project = summarize(
              yield* decodeJson(projectSchema)(String(projectRows[0].payload)),
              'project',
              String(projectRows[0].id),
              128 * 1024,
            )
            if (project.id !== projectRows[0].id)
              return yield* Effect.fail(safeError('invalid-data', 'Stored Project identity failed validation'))
            const mainRows =
              yield* sql`SELECT id, project_id, payload FROM workspace_checkout WHERE project_id = ${projectId} AND CASE WHEN json_valid(payload) THEN json_extract(payload, '$.kind') = 'main' ELSE 0 END LIMIT 2`
            if (mainRows.length !== 1)
              return yield* Effect.fail(safeError('invalid-data', 'Project must have exactly one main checkout'))
            const mainCheckout = summarize(
              yield* decodeJson(workspaceCheckoutSchema)(String(mainRows[0].payload)),
              'checkout',
              String(mainRows[0].id),
              128 * 1024,
            )
            if (
              mainCheckout.id !== mainRows[0].id ||
              mainCheckout.projectId !== projectId ||
              mainCheckout.projectId !== mainRows[0].project_id ||
              mainCheckout.kind !== 'main'
            )
              return yield* Effect.fail(safeError('invalid-data', 'Stored main checkout membership failed validation'))
            const counts =
              yield* sql`SELECT COUNT(*) AS total FROM workspace_checkout WHERE project_id = ${projectId} AND id <> ${mainCheckout.id}`
            const totalOtherCheckouts = Number(counts[0]?.total ?? 0)
            const otherCheckouts: Array<WorkspaceCheckout> = []
            let checkoutCursor = page.afterCheckoutId
            let hasMore = false
            for (let index = 0; index < page.limit; index += 1) {
              const checkouts =
                yield* sql`SELECT id, project_id, payload FROM workspace_checkout WHERE project_id = ${projectId} AND id <> ${mainCheckout.id} AND id > ${checkoutCursor} ORDER BY id LIMIT 1`
              const row = checkouts[0]
              if (!row) break
              const checkout = summarize(
                yield* decodeJson(workspaceCheckoutSchema)(String(row.payload)),
                'checkout',
                String(row.id),
              )
              if (checkout.id !== row.id || checkout.projectId !== projectId || checkout.projectId !== row.project_id)
                return yield* Effect.fail(safeError('invalid-data', 'Stored checkout membership failed validation'))
              const candidate = [...otherCheckouts, checkout]
              if (
                Buffer.byteLength(
                  JSON.stringify({
                    project,
                    mainCheckout,
                    otherCheckouts: candidate,
                    totalOtherCheckouts,
                    nextAfterCheckoutId: checkout.id,
                  }),
                  'utf8',
                ) > WORKSPACE_STORE_READ_BYTE_CAPACITY
              ) {
                if (otherCheckouts.length === 0)
                  return yield* Effect.fail(
                    safeError('invalid-data', 'Stored checkout exceeds the project detail byte limit'),
                  )
                hasMore = true
                break
              }
              otherCheckouts.push(checkout)
              checkoutCursor = checkout.id
            }
            if (!hasMore) {
              const more =
                yield* sql`SELECT 1 AS found FROM workspace_checkout WHERE project_id = ${projectId} AND id <> ${mainCheckout.id} AND id > ${checkoutCursor} LIMIT 1`
              hasMore = more.length > 0
            }
            return yield* Schema.decodeUnknownEffect(workspaceProjectDetailSchema)({
              project,
              mainCheckout,
              otherCheckouts,
              totalOtherCheckouts,
              nextAfterCheckoutId: hasMore ? checkoutCursor : null,
            }).pipe(Effect.mapError(() => safeError('invalid-data', 'Stored project detail failed validation')))
          }),
        )
      }),
    )

  const listTasks: WorkspaceStore['Service']['listTasks'] = (projectId, options) =>
    guard(
      Effect.gen(function* () {
        const { afterId, limit } = yield* decodeEntityPageOptions(options)
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const projects = yield* sql`SELECT payload FROM workspace_project WHERE id = ${projectId}`
            if (!projects[0]) return yield* Effect.fail(safeError('not-found', 'Project does not exist'))
            const project = yield* decodeJson(projectSchema)(String(projects[0].payload))
            if (project.id !== projectId)
              return yield* Effect.fail(safeError('invalid-data', 'Stored Project identity failed validation'))
            const counts =
              yield* sql`SELECT COUNT(*) AS total FROM workspace_task WHERE project_id = ${projectId} AND archived = 0`
            const total = Number(counts[0]?.total ?? 0)
            const items: Array<Task> = []
            let cursor = afterId
            let hasMore = false
            for (let index = 0; index < limit; index += 1) {
              const rows =
                yield* sql`SELECT id, payload FROM workspace_task WHERE project_id = ${projectId} AND archived = 0 AND id > ${cursor} ORDER BY id LIMIT 1`
              const row = rows[0]
              if (!row) break
              const task = summarize(yield* decodeJson(taskSchema)(String(row.payload)), 'task', String(row.id))
              if (task.id !== row.id || task.projectId !== projectId)
                return yield* Effect.fail(safeError('invalid-data', 'Stored Task membership failed validation'))
              if (!(yield* appendEntityPageItem(items, task, total, 'Task'))) {
                hasMore = true
                break
              }
              cursor = task.id
            }
            if (!hasMore) {
              const more =
                yield* sql`SELECT 1 AS found FROM workspace_task WHERE project_id = ${projectId} AND archived = 0 AND id > ${cursor} LIMIT 1`
              hasMore = more.length > 0
            }
            return yield* Schema.decodeUnknownEffect(workspaceTaskReadPageSchema)({
              items,
              total,
              nextAfterId: hasMore ? cursor : null,
            }).pipe(Effect.mapError(() => safeError('invalid-data', 'Stored task page failed validation')))
          }),
        )
      }),
    )

  const listNativeAgentSessions: WorkspaceStore['Service']['listNativeAgentSessions'] = (taskId, options) =>
    guard(
      Effect.gen(function* () {
        const { afterId, limit } = yield* decodeEntityPageOptions(options)
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* requireTask(taskId)
            const counts =
              yield* sql`SELECT COUNT(*) AS total FROM workspace_agent_session WHERE task_id = ${taskId} AND native_session_id IS NOT NULL`
            const rows =
              yield* sql`SELECT * FROM workspace_agent_session WHERE task_id = ${taskId} AND native_session_id IS NOT NULL AND id > ${afterId} ORDER BY id LIMIT ${limit + 1}`
            const items = []
            let bytes = 1024
            for (const row of rows.slice(0, limit)) {
              const item = summarize(yield* decodeNativeSession(row), 'agentSession', String(row.id))
              const size = Buffer.byteLength(encode(item), 'utf8') + 1
              if (bytes + size > WORKSPACE_STORE_READ_BYTE_CAPACITY) break
              items.push(item)
              bytes += size
            }
            const truncated = rows.length > items.length
            return {
              items,
              total: Number(counts[0]?.total ?? 0),
              truncated,
              nextAfterId: truncated ? (items.at(-1)?.id ?? null) : null,
            }
          }),
        )
      }),
    )

  const readTaskDetail: WorkspaceStore['Service']['readTaskDetail'] = (taskId, options) =>
    guard(
      Effect.gen(function* () {
        const page = yield* decodeEntityPageOptions(options)
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const rows =
              yield* sql`SELECT id, project_id, payload FROM workspace_task WHERE id = ${taskId} AND archived = 0`
            const row = rows[0] as Record<string, unknown> | undefined
            if (!row) return yield* Effect.fail(safeError('not-found', 'Task does not exist'))
            const task = summarize(
              yield* decodeJson(taskSchema)(String(row.payload)),
              'task',
              String(row.id),
              128 * 1024,
            )
            if (task.id !== row.id || task.projectId !== row.project_id)
              return yield* Effect.fail(safeError('invalid-data', 'Stored Task membership failed validation'))
            const conversationCounts =
              yield* sql`SELECT COUNT(*) AS total FROM workspace_conversation WHERE task_id = ${taskId}`
            const totalConversations = Number(conversationCounts[0]?.total ?? 0)
            const conversations: Array<WorkspaceConversationRead> = []
            let conversationCursor = page.afterId
            let conversationsHaveMore = false
            for (let index = 0; index < page.limit; index += 1) {
              const conversationRows =
                yield* sql`SELECT id, task_id, payload FROM workspace_conversation WHERE task_id = ${taskId} AND id > ${conversationCursor} ORDER BY id LIMIT 1`
              const conversationRow = conversationRows[0]
              if (!conversationRow) break
              const conversation = summarize(
                yield* decodeJson(workspaceConversationReadSchema)(String(conversationRow.payload)),
                'conversation',
                String(conversationRow.id),
              )
              if (
                conversation.id !== conversationRow.id ||
                conversation.taskId !== taskId ||
                conversation.taskId !== conversationRow.task_id
              )
                return yield* Effect.fail(safeError('invalid-data', 'Stored Conversation membership failed validation'))
              const candidate = [...conversations, conversation]
              if (
                Buffer.byteLength(
                  JSON.stringify({
                    task,
                    conversations: candidate,
                    totalConversations,
                    nextAfterConversationId: conversation.id,
                  }),
                  'utf8',
                ) > WORKSPACE_STORE_READ_BYTE_CAPACITY
              ) {
                if (conversations.length === 0)
                  return yield* Effect.fail(
                    safeError('invalid-data', 'Stored Conversation exceeds the Task detail byte limit'),
                  )
                conversationsHaveMore = true
                break
              }
              conversations.push(conversation)
              conversationCursor = conversation.id
            }
            if (!conversationsHaveMore) {
              const more =
                yield* sql`SELECT 1 AS found FROM workspace_conversation WHERE task_id = ${taskId} AND id > ${conversationCursor} LIMIT 1`
              conversationsHaveMore = more.length > 0
            }
            return yield* Schema.decodeUnknownEffect(workspaceTaskDetailSchema)({
              task,
              conversations,
              totalConversations,
              nextAfterConversationId: conversationsHaveMore ? conversationCursor : null,
            }).pipe(Effect.mapError(() => safeError('invalid-data', 'Stored Task detail failed validation')))
          }),
        )
      }),
    )

  const listPendingRuntimeRequests: WorkspaceStore['Service']['listPendingRuntimeRequests'] = (
    taskId,
    afterSequence,
    limit,
  ) =>
    guard(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(workspacePendingRuntimeRequestPageOptionsSchema)({
          afterSequence,
          limit,
        }).pipe(Effect.mapError(() => safeError('invalid-data', 'Pending request cursor or limit is invalid')))
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* requireTask(taskId)
            let rows =
              yield* sql`SELECT s.run_id, r.task_id, e.sequence, e.payload FROM workspace_driver_request_state s JOIN workspace_agent_run r ON r.id = s.run_id LEFT JOIN workspace_execution_event e ON e.sequence = (SELECT MAX(p.sequence) FROM workspace_execution_event p WHERE p.run_id = s.run_id AND p.kind = 'driverEvent' AND CASE WHEN json_valid(p.payload) THEN json_extract(p.payload, '$.event.kind') = 'requestPending' AND json_extract(p.payload, '$.event.request.requestId') = s.request_id ELSE 0 END) WHERE s.state = 'pending' AND r.task_id = ${taskId} AND (e.sequence > ${afterSequence} OR e.sequence IS NULL) ORDER BY e.sequence LIMIT 1`
            const countRows =
              yield* sql`SELECT COUNT(*) AS total FROM workspace_driver_request_state s JOIN workspace_agent_run r ON r.id = s.run_id WHERE s.state = 'pending' AND r.task_id = ${taskId}`
            const total = Number(countRows[0]?.total ?? 0)
            const items: Array<WorkspacePendingRuntimeRequest> = []
            let cursor = afterSequence
            let hasMore = false
            let bytes = 512
            for (let index = 0; index < limit && rows[0]; index += 1) {
              const row = rows[0] as Record<string, unknown>
              const data = yield* decodeEventData('driverEvent', String(row.payload))
              const request = yield* Schema.decodeUnknownEffect(agentDriverEventSchema)(data.event).pipe(
                Effect.flatMap(event =>
                  event.kind === 'requestPending'
                    ? Effect.succeed(event.request)
                    : Effect.fail(safeError('invalid-data', 'Pending request event failed validation')),
                ),
                Effect.mapError(error =>
                  error instanceof WorkspaceStoreError
                    ? error
                    : safeError('invalid-data', 'Pending request event failed validation'),
                ),
              )
              if (request.runId !== row.run_id)
                return yield* Effect.fail(
                  safeError('invalid-data', 'Stored pending request membership failed validation'),
                )
              const storedItem = yield* Schema.decodeUnknownEffect(workspacePendingRuntimeRequestSchema)({
                runId: row.run_id,
                taskId: row.task_id,
                sequence: Number(row.sequence),
                request,
              }).pipe(Effect.mapError(() => safeError('invalid-data', 'Stored pending request failed validation')))
              const eventRows =
                yield* sql`SELECT sequence, schema_version, kind, run_id, task_id, generation, occurred_at, payload FROM workspace_execution_event WHERE sequence = ${storedItem.sequence}`
              if (!eventRows[0])
                return yield* Effect.fail(safeError('invalid-data', 'Stored pending request event is missing'))
              const sourceEvent = yield* decodeStoredEvent(eventRows[0])
              const summarizedRequest = summarize(storedItem.request, 'event', String(storedItem.sequence))
              const item = summarizedRequest.payloadRef
                ? {
                    ...storedItem,
                    request: summarizedRequest,
                    payloadTruncated: true as const,
                    payloadRef: { ...summarizedRequest.payloadRef, digest: fingerprint(sourceEvent) },
                  }
                : storedItem
              const itemBytes = Buffer.byteLength(encode(item), 'utf8') + 1
              if (bytes + itemBytes > WORKSPACE_STORE_READ_BYTE_CAPACITY) {
                if (items.length === 0)
                  return yield* Effect.fail(
                    safeError('invalid-data', 'Stored pending request exceeds the read page byte limit'),
                  )
                hasMore = true
                break
              }
              items.push(item)
              bytes += itemBytes
              cursor = item.sequence
              const nextRows =
                yield* sql`SELECT s.run_id, r.task_id, e.sequence, e.payload FROM workspace_driver_request_state s JOIN workspace_agent_run r ON r.id = s.run_id LEFT JOIN workspace_execution_event e ON e.sequence = (SELECT MAX(p.sequence) FROM workspace_execution_event p WHERE p.run_id = s.run_id AND p.kind = 'driverEvent' AND CASE WHEN json_valid(p.payload) THEN json_extract(p.payload, '$.event.kind') = 'requestPending' AND json_extract(p.payload, '$.event.request.requestId') = s.request_id ELSE 0 END) WHERE s.state = 'pending' AND r.task_id = ${taskId} AND (e.sequence > ${cursor} OR e.sequence IS NULL) ORDER BY e.sequence LIMIT 1`
              if (index + 1 >= limit || !nextRows[0]) {
                hasMore = !!nextRows[0]
                break
              }
              rows = nextRows
            }
            return yield* Schema.decodeUnknownEffect(workspacePendingRuntimeRequestPageSchema)({
              items,
              total,
              nextAfterSequence: hasMore ? cursor : null,
              hasMore,
            }).pipe(Effect.mapError(() => safeError('invalid-data', 'Pending request page failed validation')))
          }),
        )
      }),
    )

  const readConversationPage: WorkspaceStore['Service']['readConversationPage'] = (
    conversationId,
    afterSequence,
    limit,
    throughSequence,
  ) =>
    guard(
      Effect.gen(function* () {
        yield* Schema.decodeUnknownEffect(workspaceEventPageOptionsSchema)({
          afterSequence,
          limit,
          throughSequence,
        }).pipe(Effect.mapError(() => safeError('invalid-data', 'Conversation cursor or page limit is invalid')))
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const conversations =
              yield* sql`SELECT id, task_id, payload FROM workspace_conversation WHERE id = ${conversationId}`
            if (!conversations[0]) return yield* Effect.fail(safeError('not-found', 'Conversation does not exist'))
            const conversation = yield* decodeJson(workspaceConversationReadSchema)(String(conversations[0].payload))
            if (conversation.id !== conversationId || conversation.taskId !== conversations[0].task_id)
              return yield* Effect.fail(safeError('invalid-data', 'Stored Conversation membership failed validation'))
            const highs = yield* sql`SELECT COALESCE(MAX(sequence), 0) AS high FROM workspace_execution_event`
            const latestSequence = Number(highs[0]?.high ?? 0)
            if (throughSequence !== undefined && throughSequence > latestSequence)
              return yield* Effect.fail(safeError('invalid-data', 'Conversation high watermark is invalid'))
            const highWatermark = throughSequence ?? latestSequence
            const items: Array<WorkspaceConversationPageItem> = []
            let cursor = afterSequence
            let hasMore = false
            let bytes = 1024
            for (let index = 0; index < limit; index += 1) {
              const rows =
                yield* sql`SELECT e.sequence, e.schema_version, e.kind, e.run_id, e.task_id, e.generation, e.occurred_at, e.payload, m.id AS message_id, m.content AS message_content, m.created_at AS message_created_at FROM workspace_execution_event e JOIN workspace_dispatch_intent i ON i.run_id = e.run_id LEFT JOIN workspace_message m ON m.run_id = e.run_id AND m.role = 'user' AND e.kind = 'runQueued' WHERE i.conversation_id = ${conversationId} AND e.sequence > ${cursor} AND e.sequence <= ${highWatermark} ORDER BY e.sequence LIMIT 1`
              const row = rows[0] as Record<string, unknown> | undefined
              if (!row) break
              const storedEvent = yield* decodeStoredEvent(row)
              const event = summarize(storedEvent, 'event', String(storedEvent.sequence))
              const userMessage =
                row.message_id === null || row.message_id === undefined
                  ? undefined
                  : {
                      id: row.message_id,
                      content: row.message_content,
                      createdAt: row.message_created_at,
                    }
              const item = yield* Schema.decodeUnknownEffect(workspaceConversationPageItemSchema)({
                event,
                ...(userMessage ? { userMessage: summarize(userMessage, 'message', String(userMessage.id)) } : {}),
              }).pipe(Effect.mapError(() => safeError('invalid-data', 'Stored Conversation message failed validation')))
              const itemBytes = Buffer.byteLength(encode(item), 'utf8') + 1
              if (bytes + itemBytes > WORKSPACE_STORE_READ_BYTE_CAPACITY) {
                if (items.length === 0)
                  return yield* Effect.fail(
                    safeError('invalid-data', 'Stored Conversation item exceeds the read page byte limit'),
                  )
                hasMore = true
                break
              }
              items.push(item)
              bytes += itemBytes
              cursor = event.sequence
            }
            if (!hasMore && cursor < highWatermark) {
              const more =
                yield* sql`SELECT 1 AS found FROM workspace_execution_event e JOIN workspace_dispatch_intent i ON i.run_id = e.run_id WHERE i.conversation_id = ${conversationId} AND e.sequence > ${cursor} AND e.sequence <= ${highWatermark} LIMIT 1`
              hasMore = more.length > 0
            }
            return yield* Schema.decodeUnknownEffect(workspaceConversationPageSchema)({
              items,
              highWatermark,
              nextAfterSequence: hasMore ? cursor : null,
              hasMore,
            }).pipe(Effect.mapError(() => safeError('invalid-data', 'Conversation page failed validation')))
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
    bindNativeSession,
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
    acquireOwnerEpoch,
    readWorkspacePayload,
    pageEvents,
    listProjects,
    getProject,
    listTasks,
    readTaskDetail,
    listNativeAgentSessions,
    listPendingRuntimeRequests,
    readConversationPage,
    readTaskSnapshot,
  })
})

export const WorkspaceStoreLive = (options: { readonly filename: string }) => {
  const sqlLayer = Sqlite.SqliteClient.layer({ filename: options.filename })
  return Layer.effect(WorkspaceStore, makeService).pipe(Layer.provide(sqlLayer))
}
