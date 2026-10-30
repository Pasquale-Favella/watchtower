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

import { consumeCoalescedAgentEvents } from '@/core/application/execution/coalesced-event-consumer.js'
import type {
  AgentDriverError,
  AgentDriverSession,
  AgentSessionContext,
  UnsupportedAgentOperation,
} from '@/core/ports/agent-driver.js'
import { AgentDriverRegistry } from '@/core/ports/agent-driver-registry.js'
import { CheckoutResolver } from '@/core/ports/checkout-resolver.js'
import { HarnessConnectionResolver } from '@/core/ports/harness-connections.js'
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
  type EnqueueFollowUpCommand,
  type FollowUpReceipt,
  type PromotedFollowUp,
  type RecordRequestResponseCommand,
  type RecordSteerCommand,
  type SettleDeliveryCommand,
  workerEpochSchema,
  type WorkspaceExecutionEvent,
} from '@/shared/schemas/workspace-store.js'
import { WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

const positiveInteger = Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))
const executionOptionsSchema = Schema.Struct({
  ownerEpoch: workerEpochSchema,
  closeDeadlineMs: Schema.optional(positiveInteger),
  maxConcurrentRuns: Schema.optional(positiveInteger),
  maxQueuedRuns: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))),
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
  /** Every stopAll failure distinguishes native cleanup from durable settlement. */
  nativeCleanup: Schema.optional(Schema.Literals(['confirmed', 'unconfirmed'])),
}) {}

export interface ExecutionServiceOptions {
  readonly ownerEpoch: number
  readonly closeDeadlineMs?: number | undefined
  readonly maxConcurrentRuns?: number | undefined
  readonly maxQueuedRuns?: number | undefined
  readonly publishCommittedEvent?: ((event: WorkspaceExecutionEvent) => Effect.Effect<void, unknown>) | undefined
}

interface ManagedRun {
  readonly claim: DispatchClaim
  readonly ready: Deferred.Deferred<undefined>
  readonly submissionAccepted: Deferred.Deferred<undefined>
  readonly controlOrder: Semaphore.Semaphore
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
    readonly respond: (
      command: RecordRequestResponseCommand,
    ) => Effect.Effect<CommandReceipt, WorkspaceStoreError | AgentDriverError | UnsupportedAgentOperation>
    readonly steer: (
      command: RecordSteerCommand,
    ) => Effect.Effect<CommandReceipt, WorkspaceStoreError | AgentDriverError | UnsupportedAgentOperation>
    readonly enqueueFollowUp: (command: EnqueueFollowUpCommand) => Effect.Effect<FollowUpReceipt, WorkspaceStoreError>
    readonly cancelQueuedFollowUp: (
      conversationId: BeginRunCommand['conversationId'],
      commandId: string,
    ) => Effect.Effect<void, WorkspaceStoreError>
    readonly promoteQueuedFollowUp: (
      conversationId: BeginRunCommand['conversationId'],
      command: BeginRunCommand,
    ) => Effect.Effect<PromotedFollowUp | null, WorkspaceStoreError | ExecutionServiceError>
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
      maxQueuedRuns: input.maxQueuedRuns,
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
    const maxQueuedRuns = parsedOptions.maxQueuedRuns ?? 16
    const store = yield* WorkspaceStore
    const drivers = yield* AgentDriverRegistry
    const connections = yield* HarnessConnectionResolver
    const checkouts = yield* CheckoutResolver
    const appScope = yield* Scope.Scope
    const workerScope = yield* Scope.make()
    const runPermits = yield* Semaphore.make(maxConcurrentRuns)
    const admission = yield* Semaphore.make(1)
    const workers = new Map<AgentRunId, ManagedRun>()
    const controlFibers = new Set<Fiber.Fiber<unknown, unknown>>()
    const backgroundFailures: Array<Cause.Cause<unknown>> = []
    let stopping = false
    let workerScopeClosed = false
    let nativeCleanupUnconfirmed = false
    const shutdownGate = yield* Semaphore.make(1)
    let shutdownResult: Exit.Exit<void, ExecutionServiceError> | undefined

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

    const revalidateCheckout = Effect.fn('ExecutionService.revalidateCheckout')(
      function* (claim: DispatchClaim) {
        const resolved = yield* checkouts.resolve(claim.workspacePath)
        let detail = yield* store.getProject(claim.projectId)
        let registered =
          detail.mainCheckout.id === claim.checkoutId
            ? detail.mainCheckout
            : detail.otherCheckouts.find(checkout => checkout.id === claim.checkoutId)
        while (!registered && detail.nextAfterCheckoutId !== null) {
          detail = yield* store.getProject(claim.projectId, { afterCheckoutId: detail.nextAfterCheckoutId })
          registered = detail.otherCheckouts.find(checkout => checkout.id === claim.checkoutId)
        }
        if (
          !registered ||
          registered.projectId !== claim.projectId ||
          registered.path !== claim.workspacePath ||
          resolved.canonicalPath !== claim.workspacePath ||
          resolved.kind === 'directory' ||
          resolved.repositoryIdentity !== detail.project.repositoryIdentity ||
          resolved.kind !== registered.kind ||
          resolved.mainCheckoutPath !== detail.mainCheckout.path
        ) {
          return yield* new ExecutionServiceError({
            reason: 'background-failure',
            message: 'Registered checkout could not be verified for execution.',
          })
        }
      },
      Effect.mapError(
        () =>
          new ExecutionServiceError({
            reason: 'background-failure',
            message: 'Registered checkout could not be verified for execution.',
          }),
      ),
    )

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
        if (isTerminalEvent(event)) yield* Deferred.await(state.submissionAccepted)
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
          yield* revalidateCheckout(state.claim).pipe(
            Effect.tapError(error => Effect.sync(() => backgroundFailures.push(Cause.fail(error)))),
          )
          const driver = yield* drivers.resolve(state.claim.driverId)
          if (driver.driverId !== state.claim.driverId) {
            return yield* new ExecutionServiceError({
              reason: 'background-failure',
              message: 'Dispatch claim driver did not match the resolved agent driver',
            })
          }
          const connectionOptions = yield* connections.resolve(state.claim.connectionId, state.claim.driverId)
          const scope = yield* Scope.Scope
          const connectionScope = yield* Scope.make()
          yield* Scope.addFinalizer(
            scope,
            Scope.close(connectionScope, Exit.void).pipe(
              Effect.catchCause(cause =>
                Effect.sync(() => {
                  nativeCleanupUnconfirmed = true
                  backgroundFailures.push(cause)
                }),
              ),
            ),
          )
          const connection = yield* driver
            .connect(connectionOptions)
            .pipe(Effect.provideService(Scope.Scope, connectionScope))
          yield* Scope.addFinalizer(
            scope,
            connection.close(closeDeadlineMs).pipe(
              Effect.catchCause(cause =>
                Effect.sync(() => {
                  nativeCleanupUnconfirmed = true
                  backgroundFailures.push(cause)
                }),
              ),
            ),
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
          // Binding the native session admits early protocol events without
          // recording that the native turn has started.
          yield* store.bindNativeSession(state.claim.runId, {
            ownerEpoch: state.claim.ownerEpoch,
            nativeSessionId: identity.nativeSessionId,
            generation: state.claim.generation,
            recordedAt: yield* timestamp,
          })
          const eventFiber = yield* Effect.forkChild(
            consumeCoalescedAgentEvents(session.events(state.claim.runId), event => handleCommittedEvent(state, event)),
          )
          state.submitEntered = true
          const accepted = yield* Effect.raceFirst(
            Effect.gen(function* () {
              const acceptedValue: unknown = yield* session.submit({
                runId: state.claim.runId,
                messages: [{ role: 'user', content: state.claim.prompt }],
                attachmentIds: [],
              })
              const nativeAcceptance = yield* Schema.decodeUnknownEffect(nativeTurnAcceptanceSchema)(acceptedValue)
              if (
                nativeAcceptance.generation !== state.claim.generation ||
                nativeAcceptance.nativeSessionId !== identity.nativeSessionId ||
                (requestedNativeSessionId !== undefined &&
                  nativeAcceptance.nativeSessionId !== requestedNativeSessionId)
              ) {
                return yield* new ExecutionServiceError({
                  reason: 'background-failure',
                  message: 'Native turn acceptance did not match the immutable dispatch claim',
                })
              }
              state.nativeTurnId = nativeAcceptance.nativeTurnId
              yield* store.acknowledgeDispatch(state.claim.runId, {
                ownerEpoch: state.claim.ownerEpoch,
                nativeSessionId: nativeAcceptance.nativeSessionId,
                ...(nativeAcceptance.nativeTurnId !== undefined ? { nativeTurnId: nativeAcceptance.nativeTurnId } : {}),
                acknowledgedAt: yield* timestamp,
              })
              state.acknowledged = true
              yield* Deferred.succeed(state.submissionAccepted, undefined)
              return { _tag: 'accepted' as const }
            }),
            Fiber.await(eventFiber).pipe(Effect.map(exit => ({ _tag: 'event-consumer-ended' as const, exit }))),
          )
          if (accepted._tag === 'event-consumer-ended') {
            if (Exit.isFailure(accepted.exit)) return yield* Effect.failCause(accepted.exit.cause)
            return yield* new ExecutionServiceError({
              reason: 'background-failure',
              message: 'Agent event consumer ended before native submit acceptance',
            })
          }
          yield* sendNativeInterrupt(state).pipe(
            Effect.catchCause(cause => Effect.sync(() => backgroundFailures.push(cause))),
          )
          state.settled = false
          yield* Fiber.join(eventFiber)
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

    const launchClaim = (claim: DispatchClaim) =>
      Effect.gen(function* () {
        const state: ManagedRun = {
          claim,
          ready: yield* Deferred.make<undefined>(),
          submissionAccepted: yield* Deferred.make<undefined>(),
          controlOrder: yield* Semaphore.make(1),
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
        state.fiber = yield* Effect.forkIn(Effect.interruptible(trackedWorker(state)), workerScope, {
          startImmediately: true,
        })
        yield* Deferred.succeed(state.ready, undefined)
        return state
      })

    const forkOwnedControl = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.uninterruptibleMask(() =>
        Effect.gen(function* () {
          const ready = yield* Deferred.make<undefined>()
          const childRef: { current?: Fiber.Fiber<A, E> } = {}
          const tracked = Effect.gen(function* () {
            yield* Deferred.await(ready)
            return yield* effect
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (childRef.current) controlFibers.delete(childRef.current as Fiber.Fiber<unknown, unknown>)
              }),
            ),
          )
          const child = yield* Effect.forkIn(Effect.interruptible(tracked), workerScope, { startImmediately: true })
          childRef.current = child
          controlFibers.add(child as Fiber.Fiber<unknown, unknown>)
          yield* Deferred.succeed(ready, undefined)
          return child
        }),
      )

    const runOwnedControl = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E | WorkspaceStoreError> =>
      Effect.uninterruptibleMask(restore =>
        Effect.gen(function* () {
          const fiber = yield* admission.withPermit(
            Effect.gen(function* () {
              if (stopping)
                return yield* new WorkspaceStoreError({
                  code: 'invalid-transition',
                  message: 'Execution service is stopping and cannot admit a native control',
                })
              return yield* forkOwnedControl(effect)
            }),
          )
          return yield* restore(Fiber.join(fiber))
        }),
      )

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
              if (workers.size >= maxConcurrentRuns + maxQueuedRuns) {
                const failed = yield* Effect.exit(
                  store.failDispatch(receipt.runId, {
                    ownerEpoch: parsedOptions.ownerEpoch,
                    occurredAt: yield* timestamp,
                    outcome: 'failed',
                    reason: 'launch-failed',
                  }),
                )
                if (Exit.isFailure(failed)) return yield* Effect.failCause(failed.cause)
                return yield* new ExecutionServiceError({
                  reason: 'background-failure',
                  message: 'Execution queue is full; the Run was recorded as a launch failure',
                })
              }
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
              yield* launchClaim(claim)
              return receipt
            }),
          )
        }),
      )
    })

    const respond = Effect.fn('ExecutionService.respond')(function* (
      command: RecordRequestResponseCommand,
    ): Effect.fn.Return<CommandReceipt, WorkspaceStoreError | AgentDriverError | UnsupportedAgentOperation> {
      if (command.ownerEpoch !== parsedOptions.ownerEpoch)
        return yield* new WorkspaceStoreError({ code: 'stale-epoch', message: 'Response owner epoch is stale' })
      const state = workers.get(command.runId)
      if (state && state.claim.generation !== command.generation)
        return yield* new WorkspaceStoreError({
          code: 'membership-conflict',
          message: 'Response generation is stale',
        })
      return yield* runOwnedControl(
        Effect.interruptible(
          (state?.controlOrder ?? admission).withPermit(
            Effect.uninterruptibleMask(restoreNative =>
              Effect.gen(function* () {
                const receipt = yield* store.recordRequestResponse(command)
                if (receipt.replayed) return receipt
                if (!state?.session) {
                  const outcome: SettleDeliveryCommand = {
                    ownerEpoch: parsedOptions.ownerEpoch,
                    occurredAt: yield* timestamp,
                    outcome: 'uncertain',
                  }
                  yield* store.settleRequestResponse(command.runId, command.requestId, outcome)
                  return yield* new WorkspaceStoreError({
                    code: 'invalid-transition',
                    message: 'The Run has no active native session for request delivery',
                  })
                }
                const sent = yield* Effect.exit(
                  restoreNative(
                    state.session.respond(command.runId, command.requestId, command.generation, command.decision),
                  ),
                )
                const delivery = Exit.isSuccess(sent) ? sent.value : { outcome: 'uncertain' as const }
                const settled = yield* Effect.exit(
                  store.settleRequestResponse(command.runId, command.requestId, {
                    ...delivery,
                    ownerEpoch: parsedOptions.ownerEpoch,
                    occurredAt: yield* timestamp,
                  }),
                )
                if (Exit.isFailure(settled)) {
                  return yield* Effect.failCause(
                    Exit.isFailure(sent) ? Cause.combine(sent.cause, settled.cause) : settled.cause,
                  )
                }
                if (Exit.isFailure(sent)) return yield* Effect.failCause(sent.cause)
                return receipt
              }),
            ),
          ),
        ),
      )
    })

    const steer = Effect.fn('ExecutionService.steer')(function* (
      command: RecordSteerCommand,
    ): Effect.fn.Return<CommandReceipt, WorkspaceStoreError | AgentDriverError | UnsupportedAgentOperation> {
      if (command.ownerEpoch !== parsedOptions.ownerEpoch)
        return yield* new WorkspaceStoreError({ code: 'stale-epoch', message: 'Steering owner epoch is stale' })
      const state = workers.get(command.runId)
      if (state && state.claim.generation !== command.generation)
        return yield* new WorkspaceStoreError({
          code: 'membership-conflict',
          message: 'Steering generation is stale',
        })
      return yield* runOwnedControl(
        Effect.interruptible(
          (state?.controlOrder ?? admission).withPermit(
            Effect.uninterruptibleMask(restoreNative =>
              Effect.gen(function* () {
                const receipt = yield* store.recordSteer(command)
                if (receipt.replayed) return receipt
                if (!state?.session) {
                  yield* store.settleSteer(command.runId, command.commandId, {
                    ownerEpoch: parsedOptions.ownerEpoch,
                    occurredAt: yield* timestamp,
                    outcome: 'uncertain',
                  })
                  return yield* new WorkspaceStoreError({
                    code: 'invalid-transition',
                    message: 'The Run has no active native session for steering',
                  })
                }
                const sent = yield* Effect.exit(
                  restoreNative(state.session.steer(command.runId, command.expectedNativeTurnId, command.message)),
                )
                const delivery = Exit.isSuccess(sent) ? sent.value : { outcome: 'uncertain' as const }
                const settled = yield* Effect.exit(
                  store.settleSteer(command.runId, command.commandId, {
                    ...delivery,
                    ownerEpoch: parsedOptions.ownerEpoch,
                    occurredAt: yield* timestamp,
                  }),
                )
                if (Exit.isFailure(settled)) {
                  return yield* Effect.failCause(
                    Exit.isFailure(sent) ? Cause.combine(sent.cause, settled.cause) : settled.cause,
                  )
                }
                if (Exit.isFailure(sent)) return yield* Effect.failCause(sent.cause)
                return receipt
              }),
            ),
          ),
        ),
      )
    })

    const enqueueFollowUp = Effect.fn('ExecutionService.enqueueFollowUp')(function* (command: EnqueueFollowUpCommand) {
      return yield* store.enqueueFollowUp(command)
    })

    const cancelQueuedFollowUp = Effect.fn('ExecutionService.cancelQueuedFollowUp')(function* (
      conversationId: BeginRunCommand['conversationId'],
      commandId: string,
    ) {
      return yield* store.cancelQueuedFollowUp(conversationId, commandId)
    })

    const promoteQueuedFollowUp = Effect.fn('ExecutionService.promoteQueuedFollowUp')(function* (
      conversationId: BeginRunCommand['conversationId'],
      command: BeginRunCommand,
    ): Effect.fn.Return<PromotedFollowUp | null, WorkspaceStoreError | ExecutionServiceError> {
      return yield* Effect.uninterruptibleMask(() =>
        admission.withPermit(
          Effect.gen(function* () {
            if (stopping)
              return yield* new ExecutionServiceError({
                reason: 'service-stopped',
                message: 'Execution service is stopping and cannot promote a queued run',
              })
            if (workers.size >= maxConcurrentRuns + maxQueuedRuns)
              return yield* new ExecutionServiceError({
                reason: 'background-failure',
                message: 'Execution queue is full; queued follow-up remains queued',
              })
            const promoted = yield* store.promoteNextFollowUp(conversationId, command)
            if (!promoted || promoted.receipt.replayed) return promoted
            const claimResult = yield* Effect.exit(
              store.claimDispatch(promoted.receipt.runId, parsedOptions.ownerEpoch, yield* timestamp),
            )
            if (Exit.isFailure(claimResult)) {
              const settlement = yield* Effect.exit(
                store.failDispatch(promoted.receipt.runId, {
                  ownerEpoch: parsedOptions.ownerEpoch,
                  occurredAt: yield* timestamp,
                  outcome: 'failed',
                  reason: 'launch-failed',
                }),
              )
              if (Exit.isFailure(settlement))
                return yield* Effect.failCause(Cause.combine(claimResult.cause, settlement.cause))
              return yield* Effect.failCause(claimResult.cause)
            }
            yield* launchClaim(claimResult.value)
            return promoted
          }),
        ),
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
      const state = workers.get(runId)
      return yield* runOwnedControl(
        Effect.uninterruptibleMask(restoreNative =>
          Effect.gen(function* () {
            const requested = yield* Effect.exit(
              store.requestInterrupt(runId, parsedOptions.ownerEpoch, yield* timestamp),
            )
            const interrupted = state
              ? yield* Effect.exit(
                  Effect.gen(function* () {
                    state.interruptRequested = true
                    yield* restoreNative(sendNativeInterrupt(state))
                  }),
                )
              : Exit.void
            if (Exit.isFailure(requested)) {
              return yield* Effect.failCause(
                Exit.isFailure(interrupted) ? Cause.combine(requested.cause, interrupted.cause) : requested.cause,
              )
            }
            if (Exit.isFailure(interrupted)) return yield* Effect.failCause(interrupted.cause)
          }),
        ),
      )
    })

    const performStopAll = Effect.fn('ExecutionService.performStopAll')(function* (): Effect.fn.Return<
      void,
      ExecutionServiceError
    > {
      stopping = true
      yield* admission.withPermit(Effect.void)
      const states = Array.from(workers.values())
      const interruptionFibers = yield* Effect.forEach(
        states,
        state =>
          forkOwnedControl(
            Effect.gen(function* () {
              const requested = yield* Effect.exit(
                store.requestInterrupt(state.claim.runId, state.claim.ownerEpoch, yield* timestamp),
              )
              state.interruptRequested = true
              if (Exit.isFailure(requested)) backgroundFailures.push(requested.cause)
              yield* sendNativeInterrupt(state).pipe(
                Effect.catchCause(cause => Effect.sync(() => backgroundFailures.push(cause))),
              )
            }),
          ),
        { concurrency: 'unbounded' },
      )
      const fibers = yield* Effect.forEach(
        states,
        state =>
          Effect.gen(function* () {
            yield* Deferred.await(state.ready)
            return state.fiber
          }),
        { concurrency: 'unbounded' },
      )
      const allFibers = Array.from(
        new Set<Fiber.Fiber<unknown, unknown>>([
          ...fibers.filter((fiber): fiber is Fiber.Fiber<void, never> => fiber !== undefined),
          ...interruptionFibers,
          ...controlFibers,
        ]),
      )
      const drain = Effect.forEach(allFibers, fiber => Fiber.await(fiber), {
        concurrency: 'unbounded',
      })
      const forcedCleanupBudgetMs = Math.max(1, Math.ceil(closeDeadlineMs / 3))
      const forcedFiberBudgetMs = Math.max(1, Math.floor(forcedCleanupBudgetMs / 2))
      const forcedScopeBudgetMs = Math.max(1, forcedCleanupBudgetMs - forcedFiberBudgetMs)
      const drainBudgetMs = Math.max(1, closeDeadlineMs - forcedCleanupBudgetMs)
      const closeOwnedResources = (budgetMs: number) =>
        Effect.gen(function* () {
          if (workerScopeClosed) return !nativeCleanupUnconfirmed
          const closed = yield* Scope.close(workerScope, Exit.void).pipe(Effect.timeoutOption(budgetMs))
          if (Option.isNone(closed)) return false
          workerScopeClosed = true
          return !nativeCleanupUnconfirmed
        })
      const completed = yield* drain.pipe(Effect.timeoutOption(drainBudgetMs))
      if (Option.isNone(completed)) {
        for (const state of states) state.shuttingDown = true
        const forced = yield* Effect.all(
          [
            Effect.exit(
              Effect.forEach(states, state => failUnresolved(state, 'shutdown', 'uncertain'), {
                concurrency: 'unbounded',
              }),
            ),
            Effect.forEach(allFibers, fiber => Fiber.interrupt(fiber), { concurrency: 'unbounded' }),
          ],
          { concurrency: 'unbounded' },
        ).pipe(Effect.timeoutOption(forcedFiberBudgetMs))
        if (Option.isNone(forced)) {
          return yield* new ExecutionServiceError({
            reason: 'background-failure',
            message: 'Shutdown deadline expired before execution resource cleanup completed',
            nativeCleanup: 'unconfirmed',
          })
        }
        const [settlement] = forced.value
        const resourcesClosed = yield* Effect.exit(closeOwnedResources(forcedScopeBudgetMs))
        if (Exit.isFailure(resourcesClosed) || !resourcesClosed.value) {
          return yield* new ExecutionServiceError({
            reason: 'background-failure',
            message: 'Execution resources could not be confirmed closed after shutdown',
            ...(Exit.isFailure(resourcesClosed) ? { cause: resourcesClosed.cause } : {}),
            nativeCleanup: 'unconfirmed',
          })
        }
        if (Exit.isFailure(settlement)) {
          return yield* new ExecutionServiceError({
            reason: 'background-failure',
            message: 'Shutdown cleanup could not persist the uncertain execution fence',
            cause: settlement.cause,
            nativeCleanup: 'confirmed',
          })
        }
        return yield* new ExecutionServiceError({
          reason: 'background-failure',
          message: 'Shutdown deadline expired before execution resource cleanup completed',
          nativeCleanup: 'confirmed',
        })
      }
      const resourcesClosed = yield* Effect.exit(closeOwnedResources(forcedCleanupBudgetMs))
      if (Exit.isFailure(resourcesClosed) || !resourcesClosed.value) {
        return yield* new ExecutionServiceError({
          reason: 'background-failure',
          message: 'Execution resources could not be confirmed closed during shutdown',
          ...(Exit.isFailure(resourcesClosed) ? { cause: resourcesClosed.cause } : {}),
          nativeCleanup: 'unconfirmed',
        })
      }
      const failure = backgroundFailures.shift()
      if (failure) {
        return yield* new ExecutionServiceError({
          reason: 'background-failure',
          message: 'An execution worker or its owned resource failed during cleanup',
          cause: failure,
          nativeCleanup: 'confirmed',
        })
      }
    })

    // Scope release must not retry a timed-out native cleanup or mask its original result.
    const stopAll = Effect.fn('ExecutionService.stopAll')(function* () {
      return yield* Effect.uninterruptible(
        shutdownGate.withPermit(
          Effect.gen(function* () {
            if (!shutdownResult) {
              shutdownResult = yield* Effect.exit(
                performStopAll().pipe(
                  Effect.catchCause(cause => {
                    const failure = cause.reasons.find(Cause.isFailReason)?.error
                    return Effect.fail(
                      failure instanceof ExecutionServiceError
                        ? failure
                        : new ExecutionServiceError({
                            reason: 'background-failure',
                            message: 'Execution shutdown could not confirm resource cleanup',
                            cause,
                            nativeCleanup: 'unconfirmed',
                          }),
                    )
                  }),
                ),
              )
            }
            return yield* shutdownResult
          }),
        ),
      )
    })

    yield* Scope.addFinalizer(
      appScope,
      Effect.suspend(() => (shutdownResult ? Effect.void : stopAll().pipe(Effect.orDie))),
    )
    return ExecutionService.of({
      start,
      interrupt,
      respond,
      steer,
      enqueueFollowUp,
      cancelQueuedFollowUp,
      promoteQueuedFollowUp,
      stopAll,
    })
  })
