import { resolve } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as ChildProcessSpawner from 'effect/process/ChildProcessSpawner'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'

import {
  AgentDriver,
  type AgentDriverConnection,
  AgentDriverError,
  type AgentDriverSession,
  type AgentSessionContext,
  type AgentTurnInput,
  type NativeSessionReference,
  UnsupportedAgentOperation,
} from '@/core/ports/agent-driver.js'
import {
  JsonRpcClient,
  type JsonRpcEvent,
  JsonRpcFailure,
  type JsonRpcId,
  spawnJsonRpcStdio,
} from '@/infrastructure/agent-harnesses/drivers/json-rpc.js'
import { attachmentText } from '@/infrastructure/agent-harnesses/drivers/prompt-content.js'
import type {
  AgentAccessMode,
  AgentCapabilities,
  AgentConnectionIdentity,
  AgentDriverEvent,
  AgentGoalState,
  AgentPromptCatalog,
  AgentReconcileEvent,
  AgentRequestDecision,
  AgentToolMetadata,
} from '@/shared/schemas/execution.js'
import { DEFAULT_AGENT_ACCESS_MODE } from '@/shared/schemas/execution.js'
import type { ResolvedPromptAttachment } from '@/shared/schemas/prompt-context.js'
import type { AgentRunId } from '@/shared/schemas/workspace.js'

const Initialized = Schema.Struct({
  codexHome: Schema.String,
  platformFamily: Schema.String,
  platformOs: Schema.String,
  userAgent: Schema.String,
})
const ModelList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      model: Schema.String,
      displayName: Schema.String,
      isDefault: Schema.optional(Schema.Boolean),
      supportedReasoningEfforts: Schema.Array(
        Schema.Struct({ reasoningEffort: Schema.String, description: Schema.String }),
      ),
    }),
  ),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
})
const CodexSkillsList = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      cwd: Schema.String,
      skills: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          scope: Schema.optional(Schema.String),
          enabled: Schema.Boolean,
          description: Schema.optional(Schema.NullOr(Schema.String)),
          shortDescription: Schema.optional(Schema.NullOr(Schema.String)),
          interface: Schema.optional(
            Schema.NullOr(
              Schema.Struct({
                shortDescription: Schema.optional(Schema.NullOr(Schema.String)),
                userInvocable: Schema.optional(Schema.Boolean),
              }),
            ),
          ),
        }),
      ),
    }),
  ),
})

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
}

const discoverModels = Effect.fnUntraced(function* (client: JsonRpcClient): Effect.fn.Return<AgentCapabilities> {
  const models: AgentCapabilities['models'][number][] = []
  let cursor: string | undefined
  let defaultModes: AgentCapabilities['modes'] = []
  for (let page = 0; page < 3; page++) {
    const result = yield* client.request('model/list', { limit: 80, ...(cursor ? { cursor } : {}) }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ModelList)),
      Effect.timeoutOption('3 seconds'),
      Effect.catch(() => Effect.succeed({ _tag: 'None' as const })),
    )
    if (result._tag === 'None') break
    for (const model of result.value.data) {
      const modes = model.supportedReasoningEfforts.map(effort => ({
        id: effort.reasoningEffort,
        label: EFFORT_LABELS[effort.reasoningEffort] ?? effort.reasoningEffort,
      }))
      models.push({ id: model.model, label: model.displayName, modes })
      if (model.isDefault) defaultModes = modes
    }
    if (!result.value.nextCursor) break
    cursor = result.value.nextCursor
  }
  return { ...capabilities, models: models.slice(0, 240), modes: defaultModes }
})
const discoverPromptCatalog = Effect.fnUntraced(function* (
  client: JsonRpcClient,
  workspacePath: string,
): Effect.fn.Return<AgentPromptCatalog, AgentDriverError> {
  const response = yield* client.request('skills/list', { cwds: [workspacePath] }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(CodexSkillsList)),
    Effect.timeoutOption('5 seconds'),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(failure('timeout', 'Codex skill discovery timed out.')),
        onSome: Effect.succeed,
      }),
    ),
    Effect.mapError(error =>
      error instanceof AgentDriverError ? error : failure('protocol-error', 'Codex skill catalog could not be read.'),
    ),
  )
  const requested = resolve(workspacePath)
  const matchingEntry = response.data.find(entry => {
    const returned = resolve(entry.cwd)
    return process.platform === 'win32' ? returned.toLowerCase() === requested.toLowerCase() : returned === requested
  })
  const skills = (matchingEntry?.skills ?? []).slice(0, 512).map(skill => ({
    name: skill.name,
    ...(skill.scope ? { scope: skill.scope } : {}),
    enabled: skill.enabled,
    ...(skill.description || skill.shortDescription || skill.interface?.shortDescription
      ? { description: skill.description ?? skill.shortDescription ?? skill.interface?.shortDescription ?? undefined }
      : {}),
    ...(skill.interface?.userInvocable !== undefined ? { userInvocable: skill.interface.userInvocable } : {}),
  }))
  return {
    skills,
    skillsComplete: true,
    commands: [{ name: 'compact', description: 'Compact this conversation to free up context.' }],
  }
})
const ThreadResponse = Schema.Struct({ thread: Schema.Struct({ id: Schema.String }) })
const ResumedThreadResponse = Schema.Struct({
  cwd: Schema.String,
  thread: Schema.Struct({
    id: Schema.String,
    turns: Schema.optional(Schema.Array(Schema.Struct({ id: Schema.String, items: Schema.Array(Schema.Unknown) }))),
  }),
})
const HistoricalAgentMessage = Schema.Struct({
  type: Schema.Literal('agentMessage'),
  id: Schema.String,
  text: Schema.String,
})
const TurnResponse = Schema.Struct({
  turn: Schema.Struct({
    id: Schema.String,
    status: Schema.Literals(['completed', 'interrupted', 'failed', 'inProgress']),
  }),
})
const CompactResponse = Schema.Struct({
  turn: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      status: Schema.optional(Schema.Literals(['completed', 'interrupted', 'failed', 'inProgress'])),
    }),
  ),
})
const GoalResponse = Schema.Struct({ goal: Schema.optional(Schema.NullOr(Schema.Unknown)) })
const GoalNotification = Schema.Struct({
  threadId: Schema.String,
  goal: Schema.optional(Schema.NullOr(Schema.Unknown)),
})
const GoalClearedNotification = Schema.Struct({ threadId: Schema.String })
const ThreadRef = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.optional(Schema.String),
  turn: Schema.optional(Schema.Struct({ id: Schema.optional(Schema.String) })),
})
const RunNotification = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.optional(Schema.String),
  turn: Schema.optional(Schema.Struct({ id: Schema.optional(Schema.String) })),
})
const ItemNotification = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.optional(Schema.String),
  item: Schema.Struct({
    id: Schema.optional(Schema.String),
    type: Schema.optional(Schema.String),
    text: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    command: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
    cwd: Schema.optional(Schema.String),
    status: Schema.optional(Schema.String),
    aggregatedOutput: Schema.optional(Schema.NullOr(Schema.String)),
    exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
    durationMs: Schema.optional(Schema.NullOr(Schema.Number)),
    arguments: Schema.optional(Schema.Unknown),
    query: Schema.optional(Schema.String),
    url: Schema.optional(Schema.String),
    tool: Schema.optional(Schema.String),
    path: Schema.optional(Schema.String),
    savedPath: Schema.optional(Schema.NullOr(Schema.String)),
    review: Schema.optional(Schema.String),
    results: Schema.optional(Schema.Unknown),
    error: Schema.optional(
      Schema.NullOr(Schema.Union([Schema.String, Schema.Struct({ message: Schema.optional(Schema.String) })])),
    ),
    result: Schema.optional(Schema.Unknown),
    changes: Schema.optional(
      Schema.Array(
        Schema.Struct({
          path: Schema.String,
          kind: Schema.Union([Schema.String, Schema.Struct({ type: Schema.String })]),
          diff: Schema.optional(Schema.String),
        }),
      ),
    ),
  }),
})
const DeltaNotification = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.optional(Schema.String),
  delta: Schema.String,
  itemId: Schema.optional(Schema.String),
})
const TurnStateNotification = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.optional(Schema.String),
  turn: Schema.Struct({ id: Schema.optional(Schema.String), status: Schema.optional(Schema.String) }),
})
const PlanNotification = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.optional(Schema.String),
  explanation: Schema.optional(Schema.NullOr(Schema.String)),
  plan: Schema.Array(
    Schema.Struct({ step: Schema.String, status: Schema.Literals(['pending', 'inProgress', 'completed']) }),
  ),
})
const RequestDetails = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.optional(Schema.String),
  itemId: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  paths: Schema.optional(Schema.Array(Schema.String)),
  command: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)]))),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  permissions: Schema.optional(Schema.Unknown),
  questions: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          question: Schema.String,
          header: Schema.String,
          isOther: Schema.optional(Schema.Boolean),
          isSecret: Schema.optional(Schema.Boolean),
          multiSelect: Schema.optional(Schema.Boolean),
          options: Schema.optional(
            Schema.NullOr(Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String }))),
          ),
        }),
      ),
    ),
  ),
  prompt: Schema.optional(Schema.String),
})
const PermissionRequestDetails = Schema.Struct({
  fileSystem: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        read: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
        write: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
        entries: Schema.optional(
          Schema.NullOr(
            Schema.Array(
              Schema.Struct({
                access: Schema.String,
                path: Schema.optional(Schema.String),
                pattern: Schema.optional(Schema.String),
              }),
            ),
          ),
        ),
      }),
    ),
  ),
  network: Schema.optional(Schema.Unknown),
})

const supported = {
  support: 'supported',
  restrictions: [],
  evidence: [{ source: 'protocol', detail: 'Codex App Server JSONL' }],
} as const
const limitedRequests = {
  support: 'supported',
  restrictions: [
    'Command/file/additional-permission approvals and structured user questions only; other native request families are rejected.',
  ],
  evidence: [{ source: 'protocol', detail: 'Codex App Server server requests' }],
} as const
const textReplay = {
  support: 'supported',
  restrictions: ['Replays assistant text only, bounded to 128 entries; live event cursors are unsupported.'],
  evidence: [{ source: 'protocol', detail: 'Codex thread/resume history' }],
} as const
const capabilities: AgentCapabilities = {
  openSession: supported,
  loadSession: supported,
  submit: supported,
  interrupt: supported,
  steer: supported,
  respond: limitedRequests,
  reconcile: textReplay,
  models: [],
  modes: [],
  promptContent: { images: true, files: true },
}

const MAX_REPLAY_EVENTS = 128
const MAX_EVENT_TEXT_BYTES = 64 * 1024
const MAX_TOOL_OUTPUT_BYTES = 128 * 1024
const TOOL_OUTPUT_CHUNK_SIZE = 8192
const MAX_PENDING_NATIVE_REQUESTS = 128
const MAX_RETAINED_RUNS = 8
const MAX_RUN_ID_FENCES = 128
const MAX_ACTIVE_SESSIONS = 16
const MAX_RUN_EVENTS = 64
const MAX_PRE_ACCEPT_EVENTS = 64
const MAX_PRE_ACCEPT_BYTES = 64 * 1024

interface PendingRequest {
  readonly nativeId: JsonRpcId
  readonly runId: AgentRunId
  readonly generation: number
  readonly threadId: string
  readonly nativeTurnId: string
  readonly method: string
  readonly permissions?: unknown
  readonly questionOptions: ReadonlyMap<string, ReadonlyMap<string, string>>
  readonly customQuestionIds: ReadonlySet<string>
}

interface ActiveRun {
  readonly id: AgentRunId
  readonly generation: number
  readonly events: Queue.Queue<AgentDriverEvent, AgentDriverError | import('effect/Cause').Done<void>>
  nativeTurnId?: string
  goal?: AgentGoalState | null
  overflowed?: boolean
  failed?: boolean
  terminal?: boolean
  cancelWanted?: boolean
  cancelExpectedNativeTurnId?: string
  interruptRequested?: boolean
  acceptanceConfirmed?: boolean
  replayingPreAcceptance?: boolean
  preAcceptanceBytes: number
  readonly preAcceptance: JsonRpcEvent[]
}

interface SessionState {
  readonly context: AgentSessionContext
  readonly nativeSessionId: string
  readonly events: Map<AgentRunId, Queue.Queue<AgentDriverEvent, AgentDriverError | import('effect/Cause').Done<void>>>
  readonly runs: Map<AgentRunId, ActiveRun>
  readonly submittedRunIds: Set<AgentRunId>
  readonly replay: ReadonlyArray<AgentReconcileEvent>
  readonly eventLock: Semaphore.Semaphore
  goal?: AgentGoalState | null
  activeRun?: ActiveRun
}

/** Native App Server policy for one access mode. Thread calls take the mode name; turn calls take the policy object. */
interface CodexAccessPolicy {
  readonly approvalPolicy: 'untrusted' | 'on-request' | 'never'
  readonly sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  readonly sandboxPolicy: { readonly type: 'readOnly' | 'workspaceWrite' | 'dangerFullAccess' }
}
const codexAccessPolicy = (accessMode: AgentAccessMode): CodexAccessPolicy => {
  switch (accessMode) {
    case 'approval-required':
      return { approvalPolicy: 'untrusted', sandbox: 'read-only', sandboxPolicy: { type: 'readOnly' } }
    case 'auto-accept-edits':
    case 'auto':
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write', sandboxPolicy: { type: 'workspaceWrite' } }
    case 'full-access':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access', sandboxPolicy: { type: 'dangerFullAccess' } }
  }
}

const failure = (code: ConstructorParameters<typeof AgentDriverError>[0]['code'], message: string) =>
  new AgentDriverError({ code, message })
const decode = <A>(schema: Schema.Decoder<A>, value: unknown): A | undefined => {
  try {
    return Schema.decodeUnknownSync(schema)(value)
  } catch {
    return undefined
  }
}
const getThreadId = (params: unknown): string | undefined =>
  decode(ThreadRef, params)?.threadId ??
  decode(RunNotification, params)?.threadId ??
  decode(ItemNotification, params)?.threadId ??
  decode(DeltaNotification, params)?.threadId
const getNativeTurnId = (value: unknown): string | undefined =>
  decode(ThreadRef, value)?.turnId ??
  decode(ThreadRef, value)?.turn?.id ??
  decode(RunNotification, value)?.turnId ??
  decode(RunNotification, value)?.turn?.id ??
  decode(ItemNotification, value)?.turnId ??
  decode(DeltaNotification, value)?.turnId ??
  decode(TurnStateNotification, value)?.turnId ??
  decode(TurnStateNotification, value)?.turn?.id

type GoalCommand =
  { readonly kind: 'set'; readonly objective: string } | { readonly kind: 'get' | 'pause' | 'resume' | 'clear' }

function parseGoalCommand(prompt: string | undefined): GoalCommand | undefined {
  if (!prompt || !/^\/goal(?:\s|$)/.test(prompt)) return undefined
  const argument = prompt.slice('/goal'.length).trim()
  if (!argument || argument === 'get' || argument === 'show') return { kind: 'get' }
  if (argument === 'pause') return { kind: 'pause' }
  if (argument === 'resume') return { kind: 'resume' }
  if (argument === 'clear') return { kind: 'clear' }
  if (argument.startsWith('set ')) return { kind: 'set', objective: argument.slice(4).trim() }
  return { kind: 'set', objective: argument }
}

function normalizeNativeGoal(value: unknown): AgentGoalState | null | undefined {
  if (value === null || value === undefined) return null
  if (typeof value !== 'object' || value === null) return undefined
  const native = value as Record<string, unknown>
  const statuses = ['active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete'] as const
  if (
    typeof native.objective !== 'string' ||
    !native.objective.trim() ||
    !statuses.includes(native.status as (typeof statuses)[number])
  )
    return undefined
  const now = Date.now()
  const tokenBudget =
    typeof native.tokenBudget === 'number' && Number.isInteger(native.tokenBudget) && native.tokenBudget > 0
      ? native.tokenBudget
      : null
  const tokensUsed =
    typeof native.tokensUsed === 'number' && Number.isInteger(native.tokensUsed) && native.tokensUsed >= 0
      ? native.tokensUsed
      : 0
  const timeUsedSeconds =
    typeof native.timeUsedSeconds === 'number' &&
    Number.isInteger(native.timeUsedSeconds) &&
    native.timeUsedSeconds >= 0
      ? native.timeUsedSeconds
      : 0
  return {
    objective: native.objective,
    status: native.status as AgentGoalState['status'],
    tokenBudget,
    tokensUsed,
    timeUsedSeconds,
    createdAt: now,
    updatedAt: now,
  }
}

/** Native Codex App Server JSONL driver. The process and dispatcher belong to the caller's Scope. */
export function codexAgentDriverConnect(options: {
  readonly connectionId: string
  readonly configuration?: Readonly<Record<string, string>> | undefined
}) {
  return Effect.gen(function* () {
    const command = options.configuration?.command ?? 'codex'
    const server = yield* spawnJsonRpcStdio(command, ['app-server', '--stdio']).pipe(
      Effect.mapError(() => failure('driver-unavailable', 'Codex App Server could not be started.')),
    )
    return yield* codexAgentDriverFromTransport(options, server)
  })
}

/** Protocol seam used by conformance tests and alternate scoped stdio adapters. */
export function codexAgentDriverFromTransport(
  options: { readonly connectionId: string },
  server: import('@/infrastructure/agent-harnesses/drivers/json-rpc.js').JsonRpcTransport,
) {
  return Effect.gen(function* () {
    const client = yield* JsonRpcClient.make(server)
    const connectionScope = yield* Effect.scope
    const initialize = yield* client
      .request('initialize', {
        clientInfo: { name: 'watchtower', title: 'Watchtower', version: '0.1.0' },
        capabilities: {},
      })
      .pipe(Effect.mapError(toDriverFailure))
    const info = decode(Initialized, initialize)
    if (!info) return yield* failure('protocol-error', 'Codex returned an unsupported initialize response shape.')
    yield* client.notify('initialized', {}).pipe(Effect.mapError(toDriverFailure))

    const sessions = new Map<string, SessionState>()
    const requests = new Map<string, PendingRequest>()
    const identity: AgentConnectionIdentity = {
      id: options.connectionId,
      driverId: 'codex-app-server',
      authentication: 'unknown',
    }

    const connection: AgentDriverConnection = {
      identity,
      discover: () => discoverModels(client),
      discoverPromptCatalog: workspacePath => discoverPromptCatalog(client, workspacePath),
      openSession: context => openSession(client, context, undefined, sessions, requests, connectionScope),
      loadSession: (context, native) => openSession(client, context, native, sessions, requests, connectionScope),
      close: deadlineMs =>
        Effect.flatMap(failActiveRuns(sessions, requests), () => client.close(deadlineMs)).pipe(
          Effect.mapError(toDriverFailure),
        ),
    }

    yield* Effect.forkScoped(dispatch(client, sessions, requests))
    return connection
  })
}

export const codexAgentDriverLayer = Layer.effect(
  AgentDriver,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return AgentDriver.of({
      driverId: 'codex-app-server',
      accessModes: ['approval-required', 'auto-accept-edits', 'full-access'],
      connect: options =>
        codexAgentDriverConnect(options).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    })
  }),
)

function openSession(
  client: JsonRpcClient,
  context: AgentSessionContext,
  native: NativeSessionReference | undefined,
  sessions: Map<string, SessionState>,
  requests: Map<string, PendingRequest>,
  connectionScope: import('effect/Scope').Scope,
): Effect.Effect<AgentDriverSession, AgentDriverError | UnsupportedAgentOperation> {
  return Effect.gen(function* () {
    if (sessions.size >= MAX_ACTIVE_SESSIONS)
      return yield* failure('invalid-state', 'This Codex connection reached its active session limit.')
    if (native && sessions.has(native.nativeSessionId))
      return yield* failure('invalid-state', 'This Codex thread is already loaded by the connection.')
    if (native && native.generation !== context.generation)
      return yield* failure('invalid-state', 'Native session generation does not match the requested generation.')
    const policy = codexAccessPolicy(context.accessMode ?? DEFAULT_AGENT_ACCESS_MODE)
    const response = yield* client
      .request(
        native ? 'thread/resume' : 'thread/start',
        native
          ? {
              threadId: native.nativeSessionId,
              cwd: context.workspacePath,
              excludeTurns: false,
              approvalPolicy: policy.approvalPolicy,
              sandbox: policy.sandbox,
              ...(context.browserMcp ? { config: codexBrowserMcpConfig(context.browserMcp) } : {}),
            }
          : {
              cwd: context.workspacePath,
              ...(context.modelId ? { model: context.modelId } : {}),
              approvalPolicy: policy.approvalPolicy,
              sandbox: policy.sandbox,
              ...(context.browserMcp ? { config: codexBrowserMcpConfig(context.browserMcp) } : {}),
            },
      )
      .pipe(Effect.mapError(toDriverFailure))
    const resumed = native ? decode(ResumedThreadResponse, response) : undefined
    const thread = native ? resumed : decode(ThreadResponse, response)
    if (!thread?.thread.id) return yield* failure('protocol-error', 'Codex returned an invalid thread response.')
    if (resumed && resumed.cwd !== context.workspacePath)
      return yield* failure('invalid-state', 'The resumed Codex thread belongs to a different workspace path.')
    let persistedGoal: AgentGoalState | null = null
    if (native) {
      persistedGoal = yield* readNativeGoal(client, thread.thread.id)
      if (persistedGoal?.status === 'active') {
        yield* setNativeGoal(client, thread.thread.id, { status: 'paused' }).pipe(
          Effect.mapError(error =>
            failure(
              'outcome-uncertain',
              `Codex goal pause on session recovery could not be confirmed: ${error.message}`,
            ),
          ),
        )
        persistedGoal = yield* readNativeGoal(client, thread.thread.id)
        if (persistedGoal?.status !== 'paused')
          return yield* failure('outcome-uncertain', 'The resumed Codex goal could not be confirmed paused.')
      }
    }
    const history = resumed
      ? (resumed.thread.turns?.flatMap(turn =>
          turn.items.flatMap(item => {
            const message = decode(HistoricalAgentMessage, item)
            return message
              ? [
                  {
                    cursor: `${turn.id}:${message.id}`,
                    replay: true,
                    event: { kind: 'textDelta' as const, text: message.text, itemId: message.id },
                  },
                ]
              : []
          }),
        ) ?? [])
      : []
    const replay: AgentReconcileEvent[] = history
      .filter(
        item =>
          new TextEncoder().encode(item.event.kind === 'textDelta' ? item.event.text : '').byteLength <=
          MAX_EVENT_TEXT_BYTES,
      )
      .slice(0, MAX_REPLAY_EVENTS)
    if (history.length > replay.length)
      replay.push({
        replay: true,
        event: {
          kind: 'nativeNotice',
          message: 'Some native history entries were omitted by the configured replay bounds.',
        },
      })
    if (native && thread.thread.id !== native.nativeSessionId)
      return yield* failure('protocol-error', 'Codex resumed a different native thread than requested.')
    if (sessions.has(thread.thread.id))
      return yield* failure('invalid-state', 'This Codex thread is already loaded by the connection.')
    const eventLock = yield* Semaphore.make(1)
    const state: SessionState = {
      context,
      nativeSessionId: thread.thread.id,
      events: new Map(),
      runs: new Map(),
      submittedRunIds: new Set(),
      replay,
      eventLock,
      goal: persistedGoal,
    }
    sessions.set(thread.thread.id, state)
    const sessionIdentity = { nativeSessionId: thread.thread.id, generation: context.generation }

    const session: AgentDriverSession = {
      identity: sessionIdentity,
      capabilities,
      events: (runId, afterCursor) => {
        if (afterCursor)
          return Stream.fail(failure('invalid-state', 'Codex live events cannot resume from an unrecognized cursor.'))
        return Stream.unwrap(
          Effect.map(eventQueue(state, runId), queue =>
            Stream.fromQueue(queue).pipe(Stream.ensuring(releaseDrainedRun(state, runId, queue))),
          ),
        )
      },
      submit: input => submit(client, state, input, requests, sessions, connectionScope),
      interrupt: (runId, expectedNativeTurnId) => interrupt(client, state, runId, expectedNativeTurnId),
      steer: (runId, expectedNativeTurnId, message, attachments) =>
        steer(client, state, runId, expectedNativeTurnId, message, attachments),
      respond: (runId, requestId, generation, decision) =>
        respond(client, state, runId, requestId, generation, decision, requests),
      reconcile: () => Stream.fromIterable(state.replay),
    }
    return session
  })
}

function codexBrowserMcpConfig(browserMcp: NonNullable<AgentSessionContext['browserMcp']>): {
  readonly 'mcp_servers.watchtower-browser': {
    readonly url: string
    readonly http_headers: Readonly<Record<string, string>>
  }
} {
  return {
    // Override this server rather than replacing the user's MCP server table.
    'mcp_servers.watchtower-browser': {
      url: browserMcp.url,
      http_headers: { Authorization: `Bearer ${browserMcp.token}` },
    },
  }
}

function readNativeGoal(client: JsonRpcClient, threadId: string) {
  return Effect.gen(function* () {
    const response = yield* client.request('thread/goal/get', { threadId }).pipe(Effect.mapError(toDriverFailure))
    const decoded = decode(GoalResponse, response)
    if (!decoded) return yield* failure('protocol-error', 'Codex returned an invalid thread goal response.')
    const goal = normalizeNativeGoal(decoded.goal)
    if (goal === undefined) return yield* failure('protocol-error', 'Codex returned an unsupported thread goal state.')
    return goal
  })
}

function setNativeGoal(
  client: JsonRpcClient,
  threadId: string,
  update: { readonly status: 'active' | 'paused'; readonly objective?: string; readonly tokenBudget?: number | null },
) {
  return Effect.gen(function* () {
    yield* client.request('thread/goal/set', { threadId, ...update }).pipe(Effect.mapError(toDriverFailure))
    return yield* readNativeGoal(client, threadId)
  })
}

function clearNativeGoal(client: JsonRpcClient, threadId: string) {
  return Effect.gen(function* () {
    yield* client.request('thread/goal/clear', { threadId }).pipe(Effect.mapError(toDriverFailure))
    const goal = yield* readNativeGoal(client, threadId)
    if (goal !== null)
      return yield* failure('protocol-error', 'Codex did not confirm that the thread goal was cleared.')
    return null
  })
}

function submit(
  client: JsonRpcClient,
  state: SessionState,
  input: AgentTurnInput,
  requests: Map<string, PendingRequest>,
  sessions: Map<string, SessionState>,
  connectionScope: import('effect/Scope').Scope,
) {
  return Effect.gen(function* () {
    if (state.submittedRunIds.has(input.runId))
      return yield* failure('invalid-state', 'This run ID has already been submitted to Codex.')
    if (state.activeRun) return yield* failure('invalid-state', 'Codex already has an active run in this session.')
    if (input.attachmentIds.length > 0)
      return yield* new UnsupportedAgentOperation({
        operation: 'submit',
        message: 'Codex attachments are not supported by this driver slice.',
      })
    if (input.messages.some(message => message.role !== 'user'))
      return yield* new UnsupportedAgentOperation({
        operation: 'submit',
        message: 'Assistant transcript replay is not accepted as turn input; Codex retains its own thread history.',
      })
    const prompt = input.messages.length === 1 ? input.messages[0]?.content.trim() : undefined
    const compactCommand = prompt === '/compact'
    const goalCommand = parseGoalCommand(prompt)
    if (prompt && /^\/compact(?:\s|$)/.test(prompt) && !compactCommand)
      return yield* failure('invalid-state', 'Codex /compact does not accept arguments.')
    if (compactCommand && (input.attachmentIds.length > 0 || (input.attachments?.length ?? 0) > 0))
      return yield* new UnsupportedAgentOperation({
        operation: 'submit',
        message: 'Codex /compact does not accept attachments. Remove the attachments or send a regular message.',
      })
    if (goalCommand?.kind === 'set' && (!goalCommand.objective || goalCommand.objective.length > 4000))
      return yield* failure('invalid-state', 'Codex goals must contain between 1 and 4,000 characters.')
    if (goalCommand && (input.attachmentIds.length > 0 || (input.attachments?.length ?? 0) > 0))
      return yield* new UnsupportedAgentOperation({
        operation: 'submit',
        message: 'Codex /goal commands do not accept attachments.',
      })
    const content: CodexPromptContent[] = input.messages.map(message => ({
      type: 'text' as const,
      text: message.content,
    }))
    for (const attachment of input.attachments ?? []) {
      if (attachment.mediaType.startsWith('image/'))
        content.push({ type: 'image', url: `data:${attachment.mediaType};base64,${attachment.content}` })
      else content.push({ type: 'text', text: attachmentText(attachment) })
    }
    if (content.length === 0) return yield* failure('invalid-state', 'A Codex turn requires at least one user message.')
    const events = yield* eventQueue(state, input.runId)
    const run: ActiveRun = {
      id: input.runId,
      generation: state.context.generation,
      events,
      preAcceptance: [],
      preAcceptanceBytes: 0,
    }
    state.activeRun = run
    state.runs.set(input.runId, run)
    state.submittedRunIds.add(input.runId)
    if (state.submittedRunIds.size > MAX_RUN_ID_FENCES) {
      const oldest = state.submittedRunIds.values().next().value
      if (oldest !== undefined && oldest !== run.id) state.submittedRunIds.delete(oldest)
    }
    const tracker = yield* Effect.forkIn(
      compactCommand
        ? startCompact(client, state, run, requests, sessions)
        : goalCommand
          ? startGoalCommand(client, state, run, goalCommand, requests, sessions)
          : startTurn(client, state, run, content, requests, sessions),
      connectionScope,
      { startImmediately: true },
    )
    return yield* Fiber.join(tracker).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          run.cancelWanted = true
        }).pipe(
          Effect.flatMap(() =>
            Effect.forkIn(requestNativeInterrupt(client, state, run), connectionScope, { startImmediately: true }).pipe(
              Effect.asVoid,
            ),
          ),
        ),
      ),
    )
  })
}

type CodexPromptContent =
  { readonly type: 'text'; readonly text: string } | { readonly type: 'image'; readonly url: string }

function startGoalCommand(
  client: JsonRpcClient,
  state: SessionState,
  run: ActiveRun,
  command: GoalCommand,
  requests: Map<string, PendingRequest>,
  sessions: Map<string, SessionState>,
) {
  return Effect.gen(function* () {
    let goal: AgentGoalState | null
    switch (command.kind) {
      case 'set':
        goal = yield* setNativeGoal(client, state.nativeSessionId, {
          objective: command.objective,
          status: 'active',
        })
        break
      case 'resume': {
        const current = yield* readNativeGoal(client, state.nativeSessionId)
        if (!current) return yield* failure('invalid-state', 'There is no Codex goal to resume.')
        goal = yield* setNativeGoal(client, state.nativeSessionId, { status: 'active' })
        break
      }
      case 'pause':
        goal = yield* setNativeGoal(client, state.nativeSessionId, { status: 'paused' })
        break
      case 'clear':
        goal = yield* clearNativeGoal(client, state.nativeSessionId)
        break
      case 'get':
        goal = yield* readNativeGoal(client, state.nativeSessionId)
        break
    }
    state.goal = goal
    run.goal = goal
    yield* offerEvent(state, run, {
      kind: 'goalUpdated',
      nativeSessionId: state.nativeSessionId,
      generation: run.generation,
      goal,
    })
    if (command.kind === 'set' || command.kind === 'resume') {
      if (!goal || goal.status !== 'active')
        return yield* failure('protocol-error', 'Codex did not confirm an active goal.')
      yield* state.eventLock.withPermit(
        Effect.sync(() => {
          run.acceptanceConfirmed = true
          run.replayingPreAcceptance = true
        }),
      )
      while (true) {
        const batch = yield* state.eventLock.withPermit(
          Effect.sync(() => {
            if (run.preAcceptance.length === 0) {
              run.replayingPreAcceptance = false
              return undefined
            }
            const events = run.preAcceptance.splice(0)
            run.preAcceptanceBytes = 0
            return events
          }),
        )
        if (!batch) break
        for (const event of batch) yield* handleEvent(client, event, sessions, requests, true)
      }
      return { nativeSessionId: state.nativeSessionId, generation: run.generation }
    }
    const terminalEvent: AgentDriverEvent =
      command.kind === 'get' && goal?.status === 'complete'
        ? { kind: 'turnCompleted' }
        : command.kind === 'get' && goal?.status === 'blocked'
          ? { kind: 'turnFailed', message: 'Codex reported that the goal is blocked.' }
          : command.kind === 'get' && (goal?.status === 'budgetLimited' || goal?.status === 'usageLimited')
            ? { kind: 'turnFailed', message: `Codex goal ended with status ${goal.status}.` }
            : { kind: 'turnInterrupted' }
    yield* offerEvent(state, run, terminalEvent)
    run.terminal = true
    if (state.activeRun?.id === run.id) state.activeRun = undefined
    yield* state.eventLock.withPermit(Queue.end(run.events))
    return { nativeSessionId: state.nativeSessionId, generation: run.generation }
  })
}

function startTurn(
  client: JsonRpcClient,
  state: SessionState,
  run: ActiveRun,
  content: ReadonlyArray<CodexPromptContent>,
  requests: Map<string, PendingRequest>,
  sessions: Map<string, SessionState>,
) {
  return Effect.gen(function* () {
    const policy = codexAccessPolicy(state.context.accessMode ?? DEFAULT_AGENT_ACCESS_MODE)
    const result = yield* client
      .requestAfterIncoming('turn/start', {
        threadId: state.nativeSessionId,
        cwd: state.context.workspacePath,
        input: content,
        ...(state.context.modelId ? { model: state.context.modelId } : {}),
        ...(state.context.modeId ? { effort: state.context.modeId } : {}),
        approvalPolicy: policy.approvalPolicy,
        sandboxPolicy: policy.sandboxPolicy,
      })
      .pipe(
        Effect.mapError(error =>
          error.reason === 'closed' || error.reason === 'write-failed'
            ? failure('outcome-uncertain', 'Codex may have accepted the turn before the connection closed.')
            : toDriverFailure(error),
        ),
        Effect.tapError(error => failRun(client, state, run, error, requests)),
      )
    const turn = decode(TurnResponse, result)
    if (!turn) {
      const error = failure('protocol-error', 'Codex returned an invalid turn response.')
      yield* failRun(client, state, run, error, requests)
      return yield* error
    }
    if (run.nativeTurnId && run.nativeTurnId !== turn.turn.id) {
      const error = failure('protocol-error', 'Codex returned a turn ID that conflicts with its native events.')
      yield* failRun(client, state, run, error, requests)
      return yield* error
    }
    yield* state.eventLock.withPermit(
      Effect.sync(() => {
        run.nativeTurnId = turn.turn.id
        run.acceptanceConfirmed = true
        run.replayingPreAcceptance = true
      }),
    )
    while (true) {
      const batch = yield* state.eventLock.withPermit(
        Effect.sync(() => {
          if (run.preAcceptance.length === 0) {
            run.replayingPreAcceptance = false
            return undefined
          }
          const events = run.preAcceptance.splice(0)
          run.preAcceptanceBytes = 0
          return events
        }),
      )
      if (!batch) break
      for (const event of batch) yield* handleEvent(client, event, sessions, requests, true)
    }
    const initialTerminal =
      turn.turn.status === 'completed'
        ? { kind: 'turnCompleted' as const, nativeTurnId: turn.turn.id }
        : turn.turn.status === 'interrupted'
          ? { kind: 'turnInterrupted' as const, nativeTurnId: turn.turn.id }
          : turn.turn.status === 'failed'
            ? {
                kind: 'turnFailed' as const,
                nativeTurnId: turn.turn.id,
                message: 'Codex reported that the turn failed.',
              }
            : undefined
    if (initialTerminal) {
      yield* offerEvent(state, run, initialTerminal)
      if (state.activeRun?.id === run.id) {
        run.terminal = true
        state.activeRun = undefined
        yield* state.eventLock.withPermit(Queue.end(run.events))
      }
    }
    if (run.cancelWanted && state.activeRun?.id === run.id) yield* requestNativeInterrupt(client, state, run)
    return {
      ...(run.nativeTurnId ? { nativeTurnId: run.nativeTurnId } : {}),
      nativeSessionId: state.nativeSessionId,
      generation: run.generation,
    }
  })
}

function startCompact(
  client: JsonRpcClient,
  state: SessionState,
  run: ActiveRun,
  requests: Map<string, PendingRequest>,
  sessions: Map<string, SessionState>,
) {
  return Effect.gen(function* () {
    const response = yield* client
      .requestAfterIncoming('thread/compact/start', { threadId: state.nativeSessionId })
      .pipe(
        Effect.mapError(error =>
          error.reason === 'closed' || error.reason === 'write-failed'
            ? failure('outcome-uncertain', 'Codex may have accepted context compaction before the connection closed.')
            : error.reason === 'request-failed'
              ? failure('protocol-error', 'Codex rejected the context compaction operation.')
              : toDriverFailure(error),
        ),
        Effect.tapError(error =>
          failRun(
            client,
            state,
            run,
            error,
            requests,
            error.message === 'Codex rejected the context compaction operation.',
          ),
        ),
      )
    const compact = decode(CompactResponse, response)
    if (!compact) {
      const error = failure('protocol-error', 'Codex returned an invalid context compaction response.')
      yield* failRun(client, state, run, error, requests)
      return yield* error
    }
    const eventTurnId = run.preAcceptance.find(
      event => event._tag === 'Notification' && event.method === 'turn/started',
    )
    const startedTurnId = eventTurnId ? getNativeTurnId(eventTurnId.params) : undefined
    if (compact.turn?.id && startedTurnId && compact.turn.id !== startedTurnId) {
      const error = failure(
        'protocol-error',
        'Codex returned a compaction turn ID that conflicts with its native events.',
      )
      yield* failRun(client, state, run, error, requests)
      return yield* error
    }
    yield* state.eventLock.withPermit(
      Effect.sync(() => {
        run.nativeTurnId = compact.turn?.id ?? startedTurnId
        run.acceptanceConfirmed = true
        run.replayingPreAcceptance = true
      }),
    )
    while (true) {
      const batch = yield* state.eventLock.withPermit(
        Effect.sync(() => {
          if (run.preAcceptance.length === 0) {
            run.replayingPreAcceptance = false
            return undefined
          }
          const events = run.preAcceptance.splice(0)
          run.preAcceptanceBytes = 0
          return events
        }),
      )
      if (!batch) break
      for (const event of batch) yield* handleEvent(client, event, sessions, requests, true)
    }
    const terminal = compact.turn?.status
    if (terminal === 'completed' || terminal === 'interrupted' || terminal === 'failed') {
      const event: AgentDriverEvent =
        terminal === 'completed'
          ? { kind: 'turnCompleted', ...(run.nativeTurnId ? { nativeTurnId: run.nativeTurnId } : {}) }
          : terminal === 'interrupted'
            ? { kind: 'turnInterrupted', ...(run.nativeTurnId ? { nativeTurnId: run.nativeTurnId } : {}) }
            : {
                kind: 'turnFailed',
                ...(run.nativeTurnId ? { nativeTurnId: run.nativeTurnId } : {}),
                message: 'Codex reported that context compaction failed.',
              }
      yield* offerEvent(state, run, event)
      if (state.activeRun?.id === run.id) {
        run.terminal = true
        state.activeRun = undefined
        yield* state.eventLock.withPermit(Queue.end(run.events))
      }
    }
    if (run.cancelWanted && state.activeRun?.id === run.id) yield* requestNativeInterrupt(client, state, run)
    return {
      ...(run.nativeTurnId ? { nativeTurnId: run.nativeTurnId } : {}),
      nativeSessionId: state.nativeSessionId,
      generation: run.generation,
    }
  })
}

function requestNativeInterrupt(client: JsonRpcClient, state: SessionState, run: ActiveRun) {
  return Effect.gen(function* () {
    if (!run.nativeTurnId || state.activeRun?.id !== run.id || run.interruptRequested) return
    if (run.cancelExpectedNativeTurnId && run.cancelExpectedNativeTurnId !== run.nativeTurnId) return
    run.interruptRequested = true
    yield* client
      .request('turn/interrupt', { threadId: state.nativeSessionId, turnId: run.nativeTurnId })
      .pipe(Effect.ignore)
  })
}

function eventQueue(state: SessionState, runId: AgentRunId) {
  return state.eventLock.withPermit(
    Effect.gen(function* () {
      const existing = state.events.get(runId)
      if (existing) return existing
      if (state.submittedRunIds.has(runId))
        return yield* failure('invalid-state', 'Codex events for this completed run are no longer retained.')
      if (state.events.size >= MAX_RETAINED_RUNS)
        return yield* failure('invalid-state', 'This Codex session reached its retained run limit.')
      const events = yield* Queue.bounded<AgentDriverEvent, AgentDriverError | import('effect/Cause').Done<void>>(
        MAX_RUN_EVENTS,
      )
      state.events.set(runId, events)
      return events
    }),
  )
}

function releaseDrainedRun(
  state: SessionState,
  runId: AgentRunId,
  queue: Queue.Queue<AgentDriverEvent, AgentDriverError | import('effect/Cause').Done<void>>,
) {
  return state.eventLock.withPermit(
    Effect.gen(function* () {
      const run = state.runs.get(runId)
      if (!run?.terminal || run.events !== queue || (yield* Queue.size(queue)) !== 0) return
      state.events.delete(runId)
      state.runs.delete(runId)
    }),
  )
}

function interrupt(client: JsonRpcClient, state: SessionState, runId: AgentRunId, expected: string | undefined) {
  return Effect.gen(function* () {
    const run = state.runs.get(runId)
    if (!run || state.activeRun?.id !== runId)
      return yield* failure('invalid-state', 'There is no active Codex turn for this run.')
    if (run.generation !== state.context.generation)
      return yield* failure('invalid-state', 'The Codex goal belongs to a stale session generation.')
    if (run.goal?.status === 'active') {
      const paused = yield* setNativeGoal(client, state.nativeSessionId, { status: 'paused' }).pipe(
        Effect.mapError(error =>
          failure('outcome-uncertain', `Codex goal pause could not be confirmed before stopping: ${error.message}`),
        ),
      )
      if (paused?.status !== 'paused')
        return yield* failure('outcome-uncertain', 'Codex did not confirm that the active goal was paused.')
      run.goal = paused
      state.goal = paused
      yield* offerEvent(state, run, {
        kind: 'goalUpdated',
        nativeSessionId: state.nativeSessionId,
        generation: run.generation,
        goal: paused,
      })
      if (!run.nativeTurnId) {
        yield* offerEvent(state, run, { kind: 'turnInterrupted' })
        run.terminal = true
        state.activeRun = undefined
        yield* state.eventLock.withPermit(Queue.end(run.events))
        return { acknowledged: true, termination: 'interrupted' as const }
      }
    }
    if (!run.nativeTurnId) {
      if (!run.cancelWanted) run.cancelExpectedNativeTurnId = expected
      run.cancelWanted = true
      return { acknowledged: false, termination: 'unknown' as const }
    }
    if (expected && run.nativeTurnId !== expected)
      return yield* failure('invalid-state', 'The expected Codex turn is stale.')
    yield* client
      .request('turn/interrupt', { threadId: state.nativeSessionId, turnId: run.nativeTurnId })
      .pipe(Effect.mapError(toMutationFailure))
    return { acknowledged: true, termination: 'unknown' as const }
  })
}

function steer(
  client: JsonRpcClient,
  state: SessionState,
  runId: AgentRunId,
  expected: string | undefined,
  message: string,
  attachments: readonly ResolvedPromptAttachment[] = [],
) {
  return Effect.gen(function* () {
    const run = state.runs.get(runId)
    const goalControl = parseGoalCommand(message.trim())
    if (goalControl?.kind === 'pause' || goalControl?.kind === 'clear') {
      if (
        !run ||
        state.activeRun?.id !== runId ||
        run.generation !== state.context.generation ||
        run.goal?.status !== 'active'
      )
        return yield* failure('invalid-state', 'There is no active Codex goal for this run.')
      if (expected && run.nativeTurnId && expected !== run.nativeTurnId)
        return yield* failure('invalid-state', 'The expected Codex turn is stale.')
      const goal =
        goalControl.kind === 'pause'
          ? yield* setNativeGoal(client, state.nativeSessionId, { status: 'paused' })
          : yield* clearNativeGoal(client, state.nativeSessionId)
      if (goalControl.kind === 'pause' && goal?.status !== 'paused')
        return yield* failure('outcome-uncertain', 'Codex did not confirm that the goal was paused.')
      state.goal = goal
      run.goal = goal
      yield* offerEvent(state, run, {
        kind: 'goalUpdated',
        nativeSessionId: state.nativeSessionId,
        generation: run.generation,
        goal,
      })
      if (run.nativeTurnId) {
        run.interruptRequested = true
        yield* client
          .request('turn/interrupt', { threadId: state.nativeSessionId, turnId: run.nativeTurnId })
          .pipe(Effect.mapError(toMutationFailure))
      } else {
        yield* offerEvent(state, run, { kind: 'turnInterrupted' })
        run.terminal = true
        state.activeRun = undefined
        yield* state.eventLock.withPermit(Queue.end(run.events))
      }
      return { outcome: 'accepted' as const }
    }
    if (!run?.nativeTurnId || state.activeRun?.id !== runId)
      return yield* failure('invalid-state', 'There is no active Codex turn to steer.')
    if (!expected || run.nativeTurnId !== expected)
      return yield* failure('invalid-state', 'The expected Codex turn is stale.')
    yield* client
      .request('turn/steer', {
        threadId: state.nativeSessionId,
        expectedTurnId: expected,
        input: [
          { type: 'text', text: message },
          ...attachments.map(attachment =>
            attachment.mediaType.startsWith('image/')
              ? { type: 'image', url: `data:${attachment.mediaType};base64,${attachment.content}` }
              : { type: 'text', text: attachmentText(attachment) },
          ),
        ],
      })
      .pipe(Effect.mapError(toMutationFailure))
    return { outcome: 'accepted' as const }
  })
}

function respond(
  client: JsonRpcClient,
  state: SessionState,
  runId: AgentRunId,
  requestId: string,
  generation: number,
  decision: AgentRequestDecision,
  requests: Map<string, PendingRequest>,
) {
  return Effect.gen(function* () {
    const pending = requests.get(requestId)
    if (
      !pending ||
      pending.threadId !== state.nativeSessionId ||
      pending.runId !== runId ||
      pending.generation !== generation ||
      generation !== state.context.generation ||
      state.activeRun?.id !== runId ||
      pending.nativeTurnId !== state.activeRun.nativeTurnId
    ) {
      return yield* failure('invalid-state', 'The Codex request is stale or belongs to a different run.')
    }
    const result = responseFor(pending, decision)
    if (!result) return yield* failure('invalid-state', 'This Codex request does not accept that decision.')
    yield* client.respond(pending.nativeId, result).pipe(Effect.mapError(toDriverFailure))
    requests.delete(requestId)
    const run = state.runs.get(runId)
    if (run) yield* offerEvent(state, run, { kind: 'requestResolved', requestId, decision })
    return {
      outcome: 'accepted' as const,
      nativeRequestId: String(pending.nativeId),
      nativeConfirmation: 'unconfirmed' as const,
    }
  })
}

function responseFor(pending: PendingRequest, decision: AgentRequestDecision): unknown | undefined {
  if (pending.method === 'item/permissions/requestApproval') {
    if (decision.kind === 'approve' && (decision.optionId === undefined || decision.optionId === 'allow-once'))
      return { permissions: pending.permissions, scope: 'turn' }
    if (decision.kind === 'approve' && decision.optionId === 'allow-session')
      return { permissions: pending.permissions, scope: 'session' }
    if (decision.kind === 'deny' || decision.kind === 'cancel') return { permissions: {}, scope: 'turn' }
    return undefined
  }
  if (pending.method === 'item/tool/requestUserInput') {
    if (decision.kind !== 'answers') return undefined
    const answerEntries: Array<readonly [string, { readonly answers: ReadonlyArray<string> }]> = []
    for (const [questionId, answer] of Object.entries(decision.answers)) {
      const choices = pending.questionOptions.get(questionId)
      if (!choices) return undefined
      const values = Array.isArray(answer) ? answer : [answer]
      const nativeValues: string[] = []
      for (const value of values) {
        const nativeValue =
          choices.get(value) ??
          ((choices.size === 0 || pending.customQuestionIds.has(questionId)) && value.trim() ? value : undefined)
        if (nativeValue === undefined) return undefined
        nativeValues.push(nativeValue)
      }
      answerEntries.push([questionId, { answers: nativeValues }])
    }
    if (answerEntries.length !== pending.questionOptions.size) return undefined
    return { answers: Object.fromEntries(answerEntries) }
  }
  if (
    pending.method === 'item/commandExecution/requestApproval' ||
    pending.method === 'item/fileChange/requestApproval'
  ) {
    if (decision.kind === 'cancel') return { decision: 'cancel' }
    if (decision.kind === 'deny') return { decision: 'decline' }
    if (decision.kind === 'approve' && (decision.optionId === undefined || decision.optionId === 'allow-once'))
      return { decision: 'accept' }
    if (decision.kind === 'approve' && decision.optionId === 'allow-session') return { decision: 'acceptForSession' }
  }
  return undefined
}

function codexRequestTool(
  method: string,
  details: Schema.Schema.Type<typeof RequestDetails>,
): AgentToolMetadata | undefined {
  if (method === 'item/permissions/requestApproval') {
    const permissions = Schema.decodeUnknownOption(PermissionRequestDetails)(details.permissions)
    if (permissions._tag !== 'Some') return { category: 'other', ...(details.cwd ? { cwd: details.cwd } : {}) }
    const fileSystem = permissions.value.fileSystem
    const read = [
      ...(fileSystem?.read ?? []),
      ...(fileSystem?.entries ?? []).flatMap(entry =>
        entry.access === 'read' ? [entry.path, entry.pattern].flatMap(value => (value ? [value] : [])) : [],
      ),
    ]
    const write = [
      ...(fileSystem?.write ?? []),
      ...(fileSystem?.entries ?? []).flatMap(entry =>
        entry.access === 'write' ? [entry.path, entry.pattern].flatMap(value => (value ? [value] : [])) : [],
      ),
    ]
    const paths = [...new Set([...read, ...write])].slice(0, 32)
    const category = write.length
      ? 'fileWrite'
      : read.length
        ? 'fileRead'
        : permissions.value.network
          ? 'web'
          : 'command'
    return {
      category,
      ...(details.cwd ? { cwd: details.cwd } : {}),
      ...(paths.length ? { paths } : {}),
      description: boundedNativeText(JSON.stringify(details.permissions) ?? 'Requested additional permissions.', 2048),
    }
  }
  const category = method === 'item/commandExecution/requestApproval' ? 'command' : 'fileWrite'
  const command = typeof details.command === 'string' ? details.command : details.command?.join(' ')
  const paths = [...(details.paths ?? []), ...(details.path ? [details.path] : [])]
  return {
    category,
    ...(command ? { command: boundedNativeText(command, 2048) } : {}),
    ...(details.cwd ? { cwd: details.cwd } : {}),
    ...(paths.length ? { paths: [...new Set(paths)].slice(0, 32) } : {}),
    ...(details.reason ? { description: boundedNativeText(details.reason, 2048) } : {}),
  }
}

function dispatch(
  client: JsonRpcClient,
  sessions: Map<string, SessionState>,
  requests: Map<string, PendingRequest>,
): Effect.Effect<void> {
  return Stream.runForEach(client.incoming, event =>
    handleEvent(client, event, sessions, requests).pipe(Effect.ensuring(client.acknowledge(event))),
  ).pipe(Effect.catch(() => failActiveRuns(sessions, requests)))
}

function failActiveRuns(sessions: Map<string, SessionState>, requests: Map<string, PendingRequest>) {
  return Effect.gen(function* () {
    for (const state of sessions.values()) {
      const run = state.activeRun
      if (!run) continue
      yield* state.eventLock.withPermit(
        Queue.fail(run.events, failure('disconnected', 'Codex App Server disconnected while the run was active.')),
      )
      run.terminal = true
      state.activeRun = undefined
    }
    requests.clear()
  })
}

function offerEvent(state: SessionState, run: ActiveRun, event: AgentDriverEvent) {
  return state.eventLock.withPermit(
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength
      const size = yield* Queue.size(run.events)
      if (bytes > MAX_EVENT_TEXT_BYTES || size >= MAX_RUN_EVENTS) {
        yield* Queue.fail(run.events, failure('protocol-error', 'Codex event queue exceeded its count or byte limit.'))
        run.overflowed = true
        return
      }
      if (run.overflowed) return
      yield* Queue.offer(run.events, event)
    }),
  )
}

function bufferPreAcceptance(state: SessionState, run: ActiveRun, event: JsonRpcEvent) {
  return state.eventLock.withPermit(
    Effect.gen(function* () {
      const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength
      if (
        run.overflowed ||
        run.preAcceptance.length >= MAX_PRE_ACCEPT_EVENTS ||
        run.preAcceptanceBytes + bytes > MAX_PRE_ACCEPT_BYTES
      ) {
        if (!run.overflowed) {
          run.overflowed = true
          yield* Queue.fail(
            run.events,
            failure('protocol-error', 'Codex pre-accept event buffer exceeded its count or byte limit.'),
          )
        }
        return false
      }
      run.preAcceptance.push(event)
      run.preAcceptanceBytes += bytes
      return true
    }),
  )
}

function failRun(
  client: JsonRpcClient,
  state: SessionState,
  run: ActiveRun,
  error: AgentDriverError,
  requests?: Map<string, PendingRequest>,
  nativeTerminal = false,
) {
  return Effect.gen(function* () {
    const buffered = yield* state.eventLock.withPermit(
      Effect.gen(function* () {
        if (nativeTerminal) {
          run.terminal = true
          if (state.activeRun?.id === run.id) state.activeRun = undefined
        }
        if (requests)
          for (const [requestId, pending] of requests) if (pending.runId === run.id) requests.delete(requestId)
        run.failed = true
        const events = run.preAcceptance.splice(0)
        run.preAcceptanceBytes = 0
        yield* Queue.fail(run.events, error)
        return events
      }),
    )
    for (const event of buffered)
      if (event._tag === 'Request')
        yield* client
          .respondError(event.id, -32600, 'Codex turn acceptance failed before this request could be reviewed.')
          .pipe(Effect.ignore)
  })
}

function handleEvent(
  client: JsonRpcClient,
  event: JsonRpcEvent,
  sessions: Map<string, SessionState>,
  requests: Map<string, PendingRequest>,
  fromPreAcceptance = false,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (event._tag === 'Notification') {
      const threadId = getThreadId(event.params)
      const state = threadId ? sessions.get(threadId) : undefined
      if (state && event.method === 'thread/goal/updated') {
        const notification = decode(GoalNotification, event.params)
        const goal = notification ? normalizeNativeGoal(notification.goal) : undefined
        if (!notification || goal === undefined) return
        state.goal = goal
        const goalRun = state.activeRun
        if (goalRun) {
          goalRun.goal = goal
          yield* offerEvent(state, goalRun, {
            kind: 'goalUpdated',
            nativeSessionId: state.nativeSessionId,
            generation: goalRun.generation,
            goal,
          })
        }
        return
      }
      if (state && event.method === 'thread/goal/cleared') {
        const notification = decode(GoalClearedNotification, event.params)
        if (!notification) return
        state.goal = null
        const goalRun = state.activeRun
        if (goalRun) {
          goalRun.goal = null
          yield* offerEvent(state, goalRun, {
            kind: 'goalUpdated',
            nativeSessionId: state.nativeSessionId,
            generation: goalRun.generation,
            goal: null,
          })
        }
        return
      }
      if (!state?.activeRun || state.activeRun.failed) return
      const run = state.activeRun
      if (!fromPreAcceptance && (!run.acceptanceConfirmed || run.replayingPreAcceptance)) {
        yield* bufferPreAcceptance(state, run, event)
        return
      }
      const notificationTurnId = getNativeTurnId(event.params)
      if (run.goal?.status === 'active' && event.method === 'turn/started') {
        if (!notificationTurnId || run.nativeTurnId) return
        run.nativeTurnId = notificationTurnId
        yield* offerEvent(state, run, {
          kind: 'goalTurnStarted',
          nativeSessionId: state.nativeSessionId,
          generation: run.generation,
          nativeTurnId: notificationTurnId,
        })
        return
      }
      if (
        run.goal &&
        (event.method === 'turn/completed' || event.method === 'turn/interrupted' || event.method === 'turn/failed')
      ) {
        if (!notificationTurnId || notificationTurnId !== run.nativeTurnId) return
        const turnStatus =
          event.method === 'turn/interrupted'
            ? 'interrupted'
            : event.method === 'turn/failed'
              ? 'failed'
              : decode(TurnStateNotification, event.params)?.turn?.status
        if (turnStatus !== 'completed' && turnStatus !== 'interrupted' && turnStatus !== 'failed') return
        yield* offerEvent(state, run, {
          kind: 'goalTurnCompleted',
          nativeSessionId: state.nativeSessionId,
          generation: run.generation,
          nativeTurnId: notificationTurnId,
          status: turnStatus,
        })
        run.nativeTurnId = undefined
        const goal = yield* readNativeGoal(client, state.nativeSessionId).pipe(
          Effect.catch(error => {
            return Effect.gen(function* () {
              yield* offerEvent(state, run, {
                kind: 'nativeNotice',
                message: `Codex goal status could not be confirmed after its native turn: ${error.message}`,
              })
              return run.goal ?? null
            })
          }),
        )
        run.goal = goal
        state.goal = goal
        yield* offerEvent(state, run, {
          kind: 'goalUpdated',
          nativeSessionId: state.nativeSessionId,
          generation: run.generation,
          goal,
        })
        if (goal?.status === 'active' && !run.interruptRequested) return
        const terminalEvent: AgentDriverEvent =
          goal?.status === 'complete'
            ? { kind: 'turnCompleted', nativeTurnId: notificationTurnId }
            : goal?.status === 'blocked' ||
                goal?.status === 'usageLimited' ||
                goal?.status === 'budgetLimited' ||
                turnStatus === 'failed'
              ? {
                  kind: 'turnFailed',
                  nativeTurnId: notificationTurnId,
                  message: `Codex goal ended with status ${goal?.status ?? turnStatus}.`,
                }
              : { kind: 'turnInterrupted', nativeTurnId: notificationTurnId }
        yield* offerEvent(state, run, terminalEvent)
        run.terminal = true
        state.activeRun = undefined
        for (const [requestId, pending] of requests) if (pending.runId === run.id) requests.delete(requestId)
        yield* state.eventLock.withPermit(Queue.end(run.events))
        return
      }
      if (notificationTurnId && run.nativeTurnId && notificationTurnId !== run.nativeTurnId) return
      const nativeTurnId = notificationTurnId ?? run.nativeTurnId
      if (nativeTurnId) run.nativeTurnId = nativeTurnId
      const translated = notificationEvent(event.method, event.params, nativeTurnId)
      if (translated) {
        if (
          translated.kind === 'toolCompleted' &&
          translated.output !== undefined &&
          (new TextEncoder().encode(translated.output).byteLength > 16000 ||
            new TextEncoder().encode(JSON.stringify(translated)).byteLength > MAX_EVENT_TEXT_BYTES)
        ) {
          const { output, ...completed } = translated
          for (let offset = 0; offset < output.length; offset += TOOL_OUTPUT_CHUNK_SIZE) {
            yield* offerEvent(state, run, {
              kind: 'toolUpdated',
              toolCallId: completed.toolCallId,
              output: output.slice(offset, offset + TOOL_OUTPUT_CHUNK_SIZE),
              append: offset > 0,
            })
          }
          yield* offerEvent(state, run, completed)
        } else {
          yield* offerEvent(state, run, translated)
        }
        if (state.activeRun?.id !== run.id) return
        if (translated.kind === 'nativeNotice' && event.method === 'turn/completed') {
          yield* failRun(
            client,
            state,
            run,
            failure('protocol-error', 'Codex ended a turn with an unrecognized status.'),
            requests,
            true,
          )
          return
        }
        if (isTerminalEvent(translated)) {
          run.terminal = true
          state.activeRun = undefined
          for (const [requestId, pending] of requests) if (pending.runId === run.id) requests.delete(requestId)
          yield* state.eventLock.withPermit(Queue.end(run.events))
        }
      }
      return
    }

    const details = decode(RequestDetails, event.params)
    const state = details ? sessions.get(details.threadId) : undefined
    const run = state?.activeRun
    if (run && !run.failed && !fromPreAcceptance && (!run.acceptanceConfirmed || run.replayingPreAcceptance)) {
      const buffered = yield* bufferPreAcceptance(state, run, event)
      if (!buffered)
        yield* client
          .respondError(event.id, -32600, 'Codex turn event buffering exceeded its configured limit.')
          .pipe(Effect.ignore)
      return
    }
    const supportedMethod =
      event.method === 'item/commandExecution/requestApproval' ||
      event.method === 'item/fileChange/requestApproval' ||
      event.method === 'item/permissions/requestApproval' ||
      event.method === 'item/tool/requestUserInput'
    if (
      !details ||
      !state ||
      !run ||
      run.failed ||
      !supportedMethod ||
      !details.turnId ||
      !run.nativeTurnId ||
      details.turnId !== run.nativeTurnId ||
      (event.method === 'item/permissions/requestApproval' &&
        Schema.decodeUnknownOption(PermissionRequestDetails)(details.permissions)._tag !== 'Some') ||
      requests.size >= MAX_PENDING_NATIVE_REQUESTS
    ) {
      // Never infer approval. An unknown approval remains unapproved and is rejected explicitly.
      yield* client
        .respondError(event.id, -32600, 'No active Watchtower run is available to review this request.')
        .pipe(Effect.ignore)
      return
    }
    const requestId = `${state.nativeSessionId}:${String(event.id)}`
    const questionOptions = new Map(
      (details.questions ?? []).map(question => [
        question.id,
        new Map(
          (question.options ?? []).flatMap((option, optionIndex) => [
            [`${option.label}:${optionIndex}`, option.label],
            [option.label, option.label],
          ]),
        ),
      ]),
    )
    requests.set(requestId, {
      nativeId: event.id,
      runId: run.id,
      generation: run.generation,
      threadId: state.nativeSessionId,
      nativeTurnId: run.nativeTurnId,
      method: event.method,
      ...(event.method === 'item/permissions/requestApproval' ? { permissions: details.permissions } : {}),
      questionOptions,
      customQuestionIds: new Set(
        (details.questions ?? [])
          .filter(question => question.isOther === true || !question.options?.length)
          .map(question => question.id),
      ),
    })
    const questionRequest = event.method === 'item/tool/requestUserInput'
    const permissionRequest = event.method === 'item/permissions/requestApproval'
    const questions = questionRequest
      ? (details.questions ?? []).map(question => ({
          id: question.id,
          prompt: question.question,
          header: question.header,
          allowCustomAnswer: question.isOther === true || !question.options?.length,
          ...(question.isSecret !== undefined ? { isSecret: question.isSecret } : {}),
          multiSelect: question.multiSelect ?? false,
          options: (question.options ?? []).map((option, optionIndex) => ({
            id: `${option.label}:${optionIndex}`,
            label: option.label,
            description: option.description,
          })),
        }))
      : []
    const requestTool = codexRequestTool(event.method, details)
    const approvalOptions = questionRequest
      ? undefined
      : [
          {
            id: 'allow-once',
            label: 'Allow once',
            scope: 'once' as const,
            kind: 'allow' as const,
            decision: { kind: 'approve' as const, optionId: 'allow-once' },
          },
          {
            id: 'allow-session',
            label: 'Allow for this session',
            scope: 'session' as const,
            kind: 'allowAlways' as const,
            decision: { kind: 'approve' as const, optionId: 'allow-session' },
          },
          { id: 'decline', label: 'Decline', kind: 'deny' as const, decision: { kind: 'deny' as const } },
          { id: 'cancel', label: 'Cancel turn', kind: 'deny' as const, decision: { kind: 'cancel' as const } },
        ]
    const pending: AgentDriverEvent = {
      kind: 'requestPending',
      request: {
        requestId,
        runId: run.id,
        generation: run.generation,
        kind: questionRequest ? 'question' : 'approval',
        prompt:
          details.prompt ??
          details.reason ??
          (typeof details.command === 'string'
            ? details.command
            : (details.command?.join(' ') ??
              (permissionRequest ? 'Codex requests additional permissions.' : 'Codex requests permission.'))),
        ...(details.itemId ? { toolCallId: details.itemId } : {}),
        ...(requestTool ? { tool: requestTool } : {}),
        ...(approvalOptions ? { options: approvalOptions } : {}),
        questions,
        sessionId: state.context.sessionId,
        nativeRequestId: String(event.id),
      },
    }
    yield* offerEvent(state, run, pending)
  })
}

function notificationEvent(method: string, params: unknown, turnId: string | undefined): AgentDriverEvent | undefined {
  if (method === 'turn/plan/updated') {
    const plan = decode(PlanNotification, params)
    if (plan)
      return {
        kind: 'planUpdated',
        entries: plan.plan.map(entry => ({ content: entry.step, status: entry.status })),
        ...(plan.explanation ? { explanation: plan.explanation } : {}),
      }
  }
  if (method === 'turn/started') return { kind: 'turnStarted', ...(turnId ? { nativeTurnId: turnId } : {}) }
  if (method === 'turn/completed') {
    const turn = decode(TurnStateNotification, params)?.turn
    if (turn?.status === 'completed') return { kind: 'turnCompleted', ...(turnId ? { nativeTurnId: turnId } : {}) }
    if (turn?.status === 'interrupted') return { kind: 'turnInterrupted', ...(turnId ? { nativeTurnId: turnId } : {}) }
    if (turn?.status === 'failed')
      return {
        kind: 'turnFailed',
        ...(turnId ? { nativeTurnId: turnId } : {}),
        message: 'Codex reported that the turn failed.',
      }
    return { kind: 'nativeNotice', message: 'Codex ended a turn with an unrecognized status; no success was inferred.' }
  }
  if (method === 'turn/interrupted') return { kind: 'turnInterrupted', ...(turnId ? { nativeTurnId: turnId } : {}) }
  if (method === 'turn/failed')
    return {
      kind: 'turnFailed',
      ...(turnId ? { nativeTurnId: turnId } : {}),
      message: 'Codex reported that the turn failed.',
    }
  const delta = decode(DeltaNotification, params)
  if (method === 'item/agentMessage/delta' && delta)
    return { kind: 'textDelta', text: delta.delta, ...(delta.itemId ? { itemId: delta.itemId } : {}) }
  if ((method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') && delta)
    return { kind: 'reasoningDelta', text: delta.delta, ...(delta.itemId ? { itemId: delta.itemId } : {}) }
  if (method === 'item/commandExecution/outputDelta' && delta?.itemId)
    return { kind: 'toolUpdated', toolCallId: delta.itemId, output: delta.delta, append: true }
  const item = decode(ItemNotification, params)
  if (method === 'item/completed' && item?.item.type) {
    const completed = item.item
    if (completed.type === 'imageView' || completed.type === 'imageGeneration') {
      if (completed.status === 'failed') return { kind: 'nativeNotice', message: 'Image generation failed.' }
      const path = completed.savedPath ?? completed.path
      if (path)
        return {
          kind: 'media',
          mediaType: 'image/png',
          url: path,
          ...(completed.id ? { itemId: completed.id } : {}),
          alt: completed.type === 'imageView' ? 'Viewed image' : 'Generated image',
        }
      if (
        typeof completed.result === 'string' &&
        completed.result.length < 60000 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(completed.result)
      )
        return {
          kind: 'media',
          mediaType: 'image/png',
          url: `data:image/png;base64,${completed.result}`,
          ...(completed.id ? { itemId: completed.id } : {}),
          alt: 'Generated image',
        }
      return { kind: 'nativeNotice', message: 'Generated image has no available preview.' }
    }
    if (completed.type === 'contextCompaction') return { kind: 'nativeNotice', message: 'Agent context compacted.' }
    if (completed.type === 'enteredReviewMode' || completed.type === 'exitedReviewMode')
      return {
        kind: 'nativeNotice',
        message:
          (completed.review ? boundedNativeText(completed.review, 16000) : undefined) ||
          (completed.type === 'enteredReviewMode' ? 'Agent started a review.' : 'Agent finished the review.'),
      }
  }
  const toolTypes = new Set([
    'commandExecution',
    'fileChange',
    'mcpToolCall',
    'dynamicToolCall',
    'collabAgentToolCall',
    'webSearch',
  ])
  if (method === 'item/started' && item?.item.id && item.item.type && toolTypes.has(item.item.type)) {
    return {
      kind: 'toolStarted',
      toolCallId: item.item.id,
      name: item.item.name?.trim() || item.item.type,
      ...codexToolDetails(item.item),
    }
  }
  if (method === 'item/completed' && item?.item.id && item.item.type && toolTypes.has(item.item.type)) {
    const completed = item.item
    let output = completed.aggregatedOutput ?? undefined
    if (output === undefined && completed.result !== undefined) output = JSON.stringify(completed.result)
    if (output === undefined && completed.results !== undefined) output = JSON.stringify(completed.results)
    const failed =
      completed.status === 'failed' ||
      (completed.exitCode != null && completed.exitCode !== 0) ||
      completed.error != null
    return {
      kind: 'toolCompleted',
      toolCallId: item.item.id,
      name: completed.name?.trim() || item.item.type,
      ...codexToolDetails(completed),
      ...(output !== undefined ? { output: boundedNativeText(output, MAX_TOOL_OUTPUT_BYTES) } : {}),
      ...(failed
        ? {
            error:
              typeof completed.error === 'string'
                ? completed.error
                : (completed.error?.message ?? 'Tool execution failed.'),
          }
        : {}),
    }
  }
  return undefined
}

function boundedNativeText(value: string, limit = 8000): string {
  if (new TextEncoder().encode(value).byteLength <= limit) return value
  let end = Math.min(value.length, limit)
  while (new TextEncoder().encode(value.slice(0, end)).byteLength > limit - 32) end -= Math.max(1, Math.floor(end / 8))
  return `${value.slice(0, end)}\n… [truncated]`
}

function codexToolDetails(
  item: Schema.Schema.Type<typeof ItemNotification>['item'],
): AgentToolMetadata & { input?: string } {
  const categoryByType = {
    commandExecution: 'command',
    fileChange: 'fileWrite',
    mcpToolCall: 'mcp',
    dynamicToolCall: 'mcp',
    collabAgentToolCall: 'subagent',
    webSearch: 'web',
  } as const
  const category = categoryByType[item.type as keyof typeof categoryByType]
  const command = typeof item.command === 'string' ? item.command : item.command?.join(' ')
  const changes = item.changes?.slice(0, 16).flatMap((change): NonNullable<AgentToolMetadata['changes']>[number][] => {
    const kind = typeof change.kind === 'string' ? change.kind : change.kind.type
    if (kind !== 'add' && kind !== 'delete' && kind !== 'update') return []
    return [{ path: change.path, kind, ...(change.diff ? { diff: boundedNativeText(change.diff, 1500) } : {}) }]
  })
  return {
    ...(category ? { category } : {}),
    ...(command ? { command: boundedNativeText(command) } : {}),
    ...(item.cwd ? { cwd: item.cwd } : {}),
    ...(item.arguments !== undefined ? { input: boundedNativeText(JSON.stringify(item.arguments) ?? '') } : {}),
    ...(item.exitCode !== undefined && item.exitCode !== null ? { exitCode: item.exitCode } : {}),
    ...(item.durationMs !== undefined && item.durationMs !== null ? { durationMs: item.durationMs } : {}),
    ...(item.query ? { description: item.query } : {}),
    ...(item.url ? { url: item.url } : {}),
    ...(changes?.length ? { changes, paths: changes.map(change => change.path) } : {}),
  }
}

function isTerminalEvent(event: AgentDriverEvent): boolean {
  return event.kind === 'turnCompleted' || event.kind === 'turnInterrupted' || event.kind === 'turnFailed'
}

function toDriverFailure(error: JsonRpcFailure): AgentDriverError {
  return failure(
    error.reason === 'closed' ? 'disconnected' : 'protocol-error',
    'Codex App Server protocol operation failed.',
  )
}

function toMutationFailure(error: JsonRpcFailure): AgentDriverError {
  return error.reason === 'closed' || error.reason === 'write-failed'
    ? failure('outcome-uncertain', 'Codex may have applied the requested mutation before the connection closed.')
    : toDriverFailure(error)
}
