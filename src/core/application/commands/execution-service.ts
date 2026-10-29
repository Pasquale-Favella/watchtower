import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'

import {
  AgentDriver,
  type AgentDriverError,
  type AgentDriverSession,
  type AgentSessionContext,
  type UnsupportedAgentOperation,
} from '@/core/ports/agent-driver.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import type { AgentDriverEvent } from '@/shared/schemas/execution.js'
import {
  agentConnectionIdentitySchema,
  agentDriverEventSchema,
  agentSessionIdentitySchema,
} from '@/shared/schemas/execution.js'
import type { AgentRunId } from '@/shared/schemas/workspace.js'
import {
  type BeginRunCommand,
  type CommandReceipt,
  type DispatchClaim,
  type DispatchFailureCommand,
  workerEpochSchema,
  type WorkspaceExecutionEvent,
} from '@/shared/schemas/workspace-store.js'
import { WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

const positiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
const executionOptionsSchema = Schema.Struct({
  ownerEpoch: workerEpochSchema,
  closeDeadlineMs: Schema.optional(positiveInteger),
  maxConcurrentRuns: Schema.optional(positiveInteger),
})
const nativeTurnAcceptanceSchema = Schema.Struct({
  nativeSessionId: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1)),
  nativeTurnId: Schema.optional(Schema.String),
  generation: workerEpochSchema,
})

export class ExecutionServiceError extends Schema.TaggedError<ExecutionServiceError>()('ExecutionServiceError', {
  reason: Schema.Literals(['invalid-options', 'service-stopped', 'background-failure']),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface ExecutionServiceOptions {
  readonly ownerEpoch: number
  readonly closeDeadlineMs?: number | undefined
  readonly maxConcurrentRuns?: number | undefined
  readonly publishCommittedEvent?: ((event: WorkspaceExecutionEvent) => Effect.Effect<void, unknown>) | undefined
}

interface ManagedRun {
  readonly claim: DispatchClaim
  readonly ready: Deferred.Deferred<undefined>
  fiber?: Fiber.Fiber<void, never> | undefined
  session?: AgentDriverSession | undefined
  nativeTurnId?: string | undefined
  submitEntered: boolean
  acknowledged: boolean
  terminal: boolean
  settled: boolean
  interruptRequested: boolean
  interruptSent: boolean
  shuttingDown: boolean
  eventCounter: number
}

const timestamp = Effect.map(DateTime.now, DateTime.formatIso)

const contextFor = (claim: DispatchClaim): AgentSessionContext => ({
  sessionId: claim.provisionalAgentSessionId as AgentSessionContext['sessionId'],
  projectId: claim.projectId,
  taskId: claim.taskId,
  conversationId: claim.conversationId,
  checkoutId: claim.checkoutId,
  workspacePath: claim.workspacePath,
  generation: claim.generation,
  ...(claim.modelId ? { modelId: claim.modelId } : {}),
  ...(claim.modeId ? { modeId: claim.modeId } : {}),
})

const isTerminalEvent = (event: AgentDriverEvent): boolean =>
  event.kind === 'turnCompleted' || event.kind === 'turnInterrupted' || event.kind === 'turnFailed'

export class ExecutionService extends Context.Service<
  ExecutionService,
  {
    readonly start: (
      command: BeginRunCommand,
    ) => Effect.Effect<CommandReceipt, WorkspaceStoreError | ExecutionServiceError>
    readonly interrupt: (
      runId: AgentRunId,
    ) => Effect.Effect<void, WorkspaceStoreError | AgentDriverError | UnsupportedAgentOperation>
    readonly stopAll: () => Effect.Effect<void, ExecutionServiceError>
  }
>()('watchtower/core/application/ExecutionService') {
  static readonly layer = (options: ExecutionServiceOptions) =>
    Layer.effect(ExecutionService, makeExecutionService(options))
}

const makeExecutionService = (input: ExecutionServiceOptions) =>
  Effect.gen(function* () {
    const parsedOptions = yield* Schema.decodeUnknownEffect(executionOptionsSchema)({
      ownerEpoch: input.ownerEpoch,
      closeDeadlineMs: input.closeDeadlineMs,
      maxConcurrentRuns: input.maxConcurrentRuns,
    }).pipe(
      Effect.mapError(
        () =>
          new ExecutionServiceError({
            reason: 'invalid-options',
            message: 'Execution owner epoch, close deadline, or concurrency limit is invalid',
          }),
      ),
    )
    const closeDeadlineMs = parsedOptions.closeDeadlineMs ?? 10_000
    const maxConcurrentRuns = parsedOptions.maxConcurrentRuns ?? 4
    const store = yield* WorkspaceStore
    const driver = yield* AgentDriver
    const appScope = yield* Scope.Scope
    const workerScope = yield* Scope.make()
    const runPermits = yield* Semaphore.make(maxConcurrentRuns)
    const admission = yield* Semaphore.make(1)
    const workers = new Map<AgentRunId, ManagedRun>()
    const backgroundFailures: Array<Cause.Cause<unknown>> = []
    let stopping = false
    let workerScopeClosed = false

    const failUnresolved = (
      state: ManagedRun,
      reason: DispatchFailureCommand['reason'],
      outcome: DispatchFailureCommand['outcome'],
    ) =>
      Effect.gen(function* () {
        if (state.terminal || state.settled) return
        yield* store.failDispatch(state.claim.runId, {
          ownerEpoch: state.claim.ownerEpoch,
          occurredAt: yield* timestamp,
          outcome,
          reason,
        })
        state.settled = true
      })

    const sendNativeInterrupt = (state: ManagedRun) =>
      Effect.suspend(() => {
        if (!state.interruptRequested || state.interruptSent || !state.acknowledged || !state.session) {
          return Effect.void
        }
        state.interruptSent = true
        const session = state.session
        return Effect.uninterruptibleMask(restore =>
          Effect.exit(restore(session.interrupt(state.claim.runId, state.nativeTurnId))).pipe(
            Effect.flatMap(result => {
              if (Exit.isFailure(result)) {
                state.interruptSent = false
                return Effect.failCause(result.cause)
              }
              return Effect.void
            }),
          ),
        )
      })

    const handleCommittedEvent = (state: ManagedRun, value: AgentDriverEvent) =>
      Effect.gen(function* () {
        const event = yield* Schema.decodeUnknownEffect(agentDriverEventSchema)(value)
        state.eventCounter += 1
        const committed = yield* store.recordDriverEvent(state.claim.runId, {
          ownerEpoch: state.claim.ownerEpoch,
          generation: state.claim.generation,
          eventId: `${state.claim.runId}:${state.claim.ownerEpoch}:${state.eventCounter}`,
          occurredAt: yield* timestamp,
          event,
        })
        if (isTerminalEvent(event)) state.terminal = true
        if (input.publishCommittedEvent) yield* input.publishCommittedEvent(committed)
        return !state.terminal
      })

    const dispatch = (state: ManagedRun) =>
      Effect.scoped(
        Effect.gen(function* () {
          if (stopping) {
            state.shuttingDown = true
            return
          }
          if (driver.driverId !== state.claim.driverId) {
            return yield* new ExecutionServiceError({
              reason: 'background-failure',
              message: 'Dispatch claim driver did not match the injected agent driver',
            })
          }
          const connection = yield* driver.connect({ connectionId: state.claim.connectionId })
          const scope = yield* Scope.Scope
          yield* Scope.addFinalizer(
            scope,
            connection
              .close(closeDeadlineMs)
              .pipe(Effect.catchCause(cause => Effect.sync(() => backgroundFailures.push(cause)))),
          )
          const connectionIdentity = yield* Schema.decodeUnknownEffect(agentConnectionIdentitySchema)(
            connection.identity,
          )
          if (
            connectionIdentity.driverId !== state.claim.driverId ||
            connectionIdentity.id !== state.claim.connectionId
          ) {
            return yield* new ExecutionServiceError({
              reason: 'background-failure',
              message: 'Driver connection identity did not match the immutable dispatch claim',
            })
          }
          if (stopping) {
            state.shuttingDown = true
            return
          }
          const context = contextFor(state.claim)
          const requestedNativeSessionId = state.claim.nativeSessionId ?? undefined
          const session =
            requestedNativeSessionId !== undefined
              ? yield* connection.loadSession(context, {
                  nativeSessionId: requestedNativeSessionId,
                  generation: state.claim.generation,
                })
              : yield* connection.openSession(context)
          const identity = yield* Schema.decodeUnknownEffect(agentSessionIdentitySchema)(session.identity)
          if (
            identity.generation !== state.claim.generation ||
            (requestedNativeSessionId !== undefined && identity.nativeSessionId !== requestedNativeSessionId)
          ) {
            return yield* new ExecutionServiceError({
              reason: 'background-failure',
              message: 'Driver session identity did not match the immutable dispatch claim',
            })
          }
          if (stopping) {
            state.shuttingDown = true
            return
          }
          state.session = session
          state.submitEntered = true
          const acceptedValue: unknown = yield* session.submit({
            runId: state.claim.runId,
            messages: [{ role: 'user', content: state.claim.prompt }],
            attachmentIds: [],
          })
          const accepted = yield* Schema.decodeUnknownEffect(nativeTurnAcceptanceSchema)(acceptedValue)
          if (
            accepted.generation !== state.claim.generation ||
            accepted.nativeSessionId !== identity.nativeSessionId ||
            (requestedNativeSessionId !== undefined && accepted.nativeSessionId !== requestedNativeSessionId)
          ) {
            return yield* new ExecutionServiceError({
              reason: 'background-failure',
              message: 'Native turn acceptance did not match the immutable dispatch claim',
            })
          }
          state.nativeTurnId = accepted.nativeTurnId
          yield* store.acknowledgeDispatch(state.claim.runId, {
            ownerEpoch: state.claim.ownerEpoch,
            nativeSessionId: accepted.nativeSessionId,
            ...(accepted.nativeTurnId !== undefined ? { nativeTurnId: accepted.nativeTurnId } : {}),
            acknowledgedAt: yield* timestamp,
          })
          state.acknowledged = true
          yield* sendNativeInterrupt(state).pipe(
            Effect.catchCause(cause => Effect.sync(() => backgroundFailures.push(cause))),
          )
          state.settled = false
          yield* Stream.runForEachWhile(session.events(state.claim.runId), event => handleCommittedEvent(state, event))
        }),
      )

    const supervise = (state: ManagedRun) =>
      Effect.uninterruptibleMask(restore =>
        Effect.gen(function* () {
          const result = yield* Effect.exit(restore(dispatch(state)))
          if (state.terminal) {
            if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause)
            return
          }
          if (state.shuttingDown) {
            yield* failUnresolved(state, 'shutdown', 'uncertain')
            return
          }
          if (state.submitEntered && !state.acknowledged) {
            yield* failUnresolved(state, 'dispatch-uncertain', 'uncertain')
            return
          }
          if (!state.submitEntered) {
            yield* failUnresolved(state, 'launch-failed', 'failed')
            return
          }
          if (Exit.isFailure(result)) {
            yield* failUnresolved(state, 'event-stream-failed', 'uncertain')
            return
          }
          yield* failUnresolved(state, 'event-stream-ended', 'uncertain')
        }),
      )

    const trackedWorker = (state: ManagedRun) =>
      Effect.gen(function* () {
        yield* Deferred.await(state.ready)
        yield* runPermits.withPermit(
          Effect.gen(function* () {
            const result = yield* Effect.exit(supervise(state))
            if (Exit.isFailure(result)) backgroundFailures.push(result.cause)
          }),
        )
      }).pipe(Effect.ensuring(Effect.sync(() => workers.delete(state.claim.runId))))

    const start = Effect.fn('ExecutionService.start')(function* (
      command: BeginRunCommand,
    ): Effect.fn.Return<CommandReceipt, WorkspaceStoreError | ExecutionServiceError> {
      return yield* Effect.uninterruptibleMask(() =>
        Effect.gen(function* () {
          return yield* admission.withPermit(
            Effect.gen(function* () {
              if (stopping) {
                return yield* new ExecutionServiceError({
                  reason: 'service-stopped',
                  message: 'Execution service is stopping and cannot accept a new run',
                })
              }
              const receipt = yield* store.beginRun(command)
              if (receipt.replayed) return receipt
              const claimResult = yield* Effect.exit(
                store.claimDispatch(receipt.runId, parsedOptions.ownerEpoch, yield* timestamp),
              )
              if (Exit.isFailure(claimResult)) {
                const settlementResult = yield* Effect.exit(
                  store.failDispatch(receipt.runId, {
                    ownerEpoch: parsedOptions.ownerEpoch,
                    occurredAt: yield* timestamp,
                    outcome: 'failed',
                    reason: 'launch-failed',
                  }),
                )
                if (Exit.isFailure(settlementResult)) {
                  return yield* Effect.failCause(Cause.combine(claimResult.cause, settlementResult.cause))
                }
                return yield* Effect.failCause(claimResult.cause)
              }
              const claim = claimResult.value
              const state: ManagedRun = {
                claim,
                ready: yield* Deferred.make<undefined>(),
                submitEntered: false,
                acknowledged: false,
                terminal: false,
                settled: false,
                interruptRequested: false,
                interruptSent: false,
                shuttingDown: false,
                eventCounter: 0,
              }
              workers.set(claim.runId, state)
              state.fiber = yield* Effect.forkIn(trackedWorker(state), workerScope, { startImmediately: true })
              yield* Deferred.succeed(state.ready, undefined)
              return receipt
            }),
          )
        }),
      )
    })

    const interrupt = Effect.fn('ExecutionService.interrupt')(function* (
      runId: AgentRunId,
    ): Effect.fn.Return<
      void,
      | WorkspaceStoreError
      | import('@/core/ports/agent-driver.js').AgentDriverError
      | import('@/core/ports/agent-driver.js').UnsupportedAgentOperation
    > {
      yield* store.requestInterrupt(runId, parsedOptions.ownerEpoch, yield* timestamp)
      const state = workers.get(runId)
      if (!state) return
      state.interruptRequested = true
      yield* sendNativeInterrupt(state)
    })

    const stopAll = Effect.fn('ExecutionService.stopAll')(function* (): Effect.fn.Return<void, ExecutionServiceError> {
      stopping = true
      yield* admission.withPermit(Effect.void)
      const states = Array.from(workers.values())
      const fibers = yield* Effect.forEach(
        states,
        state =>
          Effect.gen(function* () {
            yield* Deferred.await(state.ready)
            return state.fiber
          }),
        { concurrency: 'unbounded' },
      )
      const drain = Effect.forEach(fibers, fiber => (fiber ? Fiber.await(fiber) : Effect.void), {
        concurrency: 'unbounded',
      })
      const completed = yield* drain.pipe(Effect.timeoutOption(closeDeadlineMs))
      if (Option.isNone(completed)) {
        for (const state of states) state.shuttingDown = true
        const settlement = yield* Effect.exit(
          Effect.forEach(states, state => failUnresolved(state, 'shutdown', 'uncertain'), {
            concurrency: 'unbounded',
          }),
        )
        yield* Effect.forEach(
          fibers,
          fiber =>
            fiber ? Effect.asVoid(Effect.forkDetach(Fiber.interrupt(fiber), { startImmediately: true })) : Effect.void,
          {
            concurrency: 'unbounded',
          },
        )
        const interrupted = yield* drain.pipe(Effect.timeoutOption(closeDeadlineMs))
        if (Option.isNone(interrupted)) {
          return yield* new ExecutionServiceError({
            reason: 'background-failure',
            message: 'Shutdown deadline expired before execution resource cleanup completed',
            ...(Exit.isFailure(settlement) ? { cause: settlement.cause } : {}),
          })
        }
        if (Exit.isFailure(settlement)) {
          return yield* new ExecutionServiceError({
            reason: 'background-failure',
            message: 'Shutdown cleanup could not persist the uncertain execution fence',
            cause: settlement.cause,
          })
        }
        if (!workerScopeClosed) {
          yield* Scope.close(workerScope, Exit.void)
          workerScopeClosed = true
        }
        return yield* new ExecutionServiceError({
          reason: 'background-failure',
          message: 'Shutdown deadline expired before execution resource cleanup completed',
        })
      }
      if (!workerScopeClosed) {
        yield* Scope.close(workerScope, Exit.void)
        workerScopeClosed = true
      }
      const failure = backgroundFailures.shift()
      if (failure) {
        return yield* new ExecutionServiceError({
          reason: 'background-failure',
          message: 'An execution worker or its owned resource failed during cleanup',
          cause: failure,
        })
      }
    })

    yield* Scope.addFinalizer(appScope, stopAll().pipe(Effect.orDie))
    return ExecutionService.of({ start, interrupt, stopAll })
  })
