import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
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
import type {
  AgentCapabilities,
  AgentConnectionIdentity,
  AgentDriverEvent,
  AgentReconcileEvent,
  AgentRequestDecision,
} from '@/shared/schemas/execution.js'
import type { AgentRunId } from '@/shared/schemas/workspace.js'

const Initialized = Schema.Struct({
  codexHome: Schema.String,
  platformFamily: Schema.String,
  platformOs: Schema.String,
  userAgent: Schema.String,
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
const RequestDetails = Schema.Struct({
  threadId: Schema.String,
  turnId: Schema.optional(Schema.String),
  command: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)]))),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  questions: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          id: Schema.String,
          question: Schema.String,
          header: Schema.String,
          options: Schema.optional(
            Schema.NullOr(Schema.Array(Schema.Struct({ label: Schema.String, description: Schema.String }))),
          ),
        }),
      ),
    ),
  ),
  prompt: Schema.optional(Schema.String),
})

const supported = {
  support: 'supported',
  restrictions: [],
  evidence: [{ source: 'protocol', detail: 'Codex App Server JSONL' }],
} as const
const textOnly = {
  support: 'supported',
  restrictions: ['Text-only turns; attachments and assistant transcript injection are not supported.'],
  evidence: [{ source: 'protocol', detail: 'Codex App Server turn/start input' }],
} as const
const limitedRequests = {
  support: 'supported',
  restrictions: [
    'Command/file approvals and structured user questions only; other native request families are rejected.',
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
  submit: textOnly,
  interrupt: supported,
  steer: supported,
  respond: limitedRequests,
  reconcile: textReplay,
  models: [],
  modes: [],
}

const MAX_REPLAY_EVENTS = 128
const MAX_EVENT_TEXT_BYTES = 8 * 1024
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
  readonly questionOptions: ReadonlyMap<string, ReadonlyMap<string, string>>
}

interface ActiveRun {
  readonly id: AgentRunId
  readonly generation: number
  readonly events: Queue.Queue<AgentDriverEvent, AgentDriverError | import('effect/Cause').Done<void>>
  nativeTurnId?: string
  overflowed?: boolean
  failed?: boolean
  terminal?: boolean
  cancelWanted?: boolean
  cancelExpectedNativeTurnId?: string
  interruptRequested?: boolean
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
  activeRun?: ActiveRun
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
      discover: () => Effect.succeed(capabilities),
      openSession: context => openSession(client, context, undefined, sessions, requests, connectionScope),
      loadSession: (context, native) => openSession(client, context, native, sessions, requests, connectionScope),
      close: deadlineMs => Effect.flatMap(failActiveRuns(sessions, requests), () => client.close(deadlineMs)),
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
    if (context.modeId)
      return yield* new UnsupportedAgentOperation({
        operation: native ? 'loadSession' : 'openSession',
        message: 'Codex mode selection is not supported by this driver slice.',
      })
    if (sessions.size >= MAX_ACTIVE_SESSIONS)
      return yield* failure('invalid-state', 'This Codex connection reached its active session limit.')
    if (native && sessions.has(native.nativeSessionId))
      return yield* failure('invalid-state', 'This Codex thread is already loaded by the connection.')
    if (native && native.generation !== context.generation)
      return yield* failure('invalid-state', 'Native session generation does not match the requested generation.')
    const response = yield* client
      .request(
        native ? 'thread/resume' : 'thread/start',
        native
          ? { threadId: native.nativeSessionId, cwd: context.workspacePath, excludeTurns: false }
          : { cwd: context.workspacePath, ...(context.modelId ? { model: context.modelId } : {}) },
      )
      .pipe(Effect.mapError(toDriverFailure))
    const resumed = native ? decode(ResumedThreadResponse, response) : undefined
    const thread = native ? resumed : decode(ThreadResponse, response)
    if (!thread?.thread.id) return yield* failure('protocol-error', 'Codex returned an invalid thread response.')
    if (resumed && resumed.cwd !== context.workspacePath)
      return yield* failure('invalid-state', 'The resumed Codex thread belongs to a different workspace path.')
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
      steer: (runId, expectedNativeTurnId, message) => steer(client, state, runId, expectedNativeTurnId, message),
      respond: (runId, requestId, generation, decision) =>
        respond(client, state, runId, requestId, generation, decision, requests),
      reconcile: () => Stream.fromIterable(state.replay),
    }
    return session
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
    const content = input.messages.map(message => ({ type: 'text' as const, text: message.content }))
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
    const tracker = yield* Effect.forkIn(startTurn(client, state, run, content, requests, sessions), connectionScope, {
      startImmediately: true,
    })
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

function startTurn(
  client: JsonRpcClient,
  state: SessionState,
  run: ActiveRun,
  content: ReadonlyArray<{ readonly type: 'text'; readonly text: string }>,
  requests: Map<string, PendingRequest>,
  sessions: Map<string, SessionState>,
) {
  return Effect.gen(function* () {
    const result = yield* client
      .requestAfterIncoming('turn/start', {
        threadId: state.nativeSessionId,
        cwd: state.context.workspacePath,
        input: content,
        ...(state.context.modelId ? { model: state.context.modelId } : {}),
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
) {
  return Effect.gen(function* () {
    const run = state.runs.get(runId)
    if (!run?.nativeTurnId || state.activeRun?.id !== runId)
      return yield* failure('invalid-state', 'There is no active Codex turn to steer.')
    if (!expected || run.nativeTurnId !== expected)
      return yield* failure('invalid-state', 'The expected Codex turn is stale.')
    yield* client
      .request('turn/steer', {
        threadId: state.nativeSessionId,
        expectedTurnId: expected,
        input: [{ type: 'text', text: message }],
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
  if (pending.method === 'item/tool/requestUserInput') {
    if (decision.kind !== 'answers') return undefined
    const answerEntries: Array<readonly [string, { readonly answers: ReadonlyArray<string> }]> = []
    for (const [questionId, answer] of Object.entries(decision.answers)) {
      const choices = pending.questionOptions.get(questionId)
      if (!choices) return undefined
      const values = Array.isArray(answer) ? answer : [answer]
      const nativeValues: string[] = []
      for (const value of values) {
        const nativeValue = choices.size === 0 ? value : choices.get(value)
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
  }
  return undefined
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
      if (!state?.activeRun || state.activeRun.failed) return
      const run = state.activeRun
      if (!fromPreAcceptance && (!run.nativeTurnId || run.replayingPreAcceptance)) {
        yield* bufferPreAcceptance(state, run, event)
        return
      }
      const notificationTurnId = getNativeTurnId(event.params)
      if (notificationTurnId && run.nativeTurnId && notificationTurnId !== run.nativeTurnId) return
      const nativeTurnId = notificationTurnId ?? run.nativeTurnId
      if (nativeTurnId) run.nativeTurnId = nativeTurnId
      const translated = notificationEvent(event.method, event.params, nativeTurnId)
      if (translated) {
        yield* offerEvent(state, run, translated)
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
    if (run && !run.failed && !fromPreAcceptance && (!run.nativeTurnId || run.replayingPreAcceptance)) {
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
      questionOptions,
    })
    const questionRequest = event.method === 'item/tool/requestUserInput'
    const questions = questionRequest
      ? (details.questions ?? []).map(question => ({
          id: question.id,
          prompt: question.question,
          multiSelect: false,
          options: (question.options ?? []).map((option, optionIndex) => ({
            id: `${option.label}:${optionIndex}`,
            label: option.label,
          })),
        }))
      : []
    const approvalOptions = questionRequest
      ? undefined
      : [
          { id: 'allow-once', label: 'Allow once', scope: 'once' as const, kind: 'allow' as const },
          { id: 'decline', label: 'Decline', kind: 'deny' as const },
          { id: 'cancel', label: 'Cancel turn', kind: 'deny' as const },
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
            : (details.command?.join(' ') ?? 'Codex requests permission.')),
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
  if (method === 'item/reasoning/summaryTextDelta' && delta)
    return { kind: 'reasoningDelta', text: delta.delta, ...(delta.itemId ? { itemId: delta.itemId } : {}) }
  const item = decode(ItemNotification, params)
  const toolTypes = new Set(['commandExecution', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall', 'webSearch'])
  if (method === 'item/started' && item?.item.id && item.item.type && toolTypes.has(item.item.type)) {
    return { kind: 'toolStarted', toolCallId: item.item.id, name: item.item.name?.trim() || item.item.type }
  }
  if (method === 'item/completed' && item?.item.id && item.item.type && toolTypes.has(item.item.type))
    return { kind: 'toolCompleted', toolCallId: item.item.id }
  return undefined
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
