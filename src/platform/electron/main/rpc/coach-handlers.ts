import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Queue from 'effect/Queue'
import * as Stream from 'effect/Stream'

import { CoachRpcError, CoachRpcGroup, type CoachRunFrame } from '@/shared/rpc/coach.js'
import type { CoachEvent, CoachRunResult } from '@/shared/schemas/agents.js'
import type { NativeCoachRunnerCapabilities } from '@/platform/electron/main/coach/ipc.js'

const EVENT_CAPACITY = 128
const MAX_PENDING_EVENT_BYTES = 2 * 1024 * 1024
const MAX_SINGLE_EVENT_BYTES = 1024 * 1024
const OVERFLOW_FRAME_RESERVE_BYTES = 1024
const queueCapacity = EVENT_CAPACITY + 2
const COMPLETED_RUN_CAPACITY = 128
const END = Symbol('CoachStreamEnd')
type QueuedFrame = CoachRunFrame | typeof END

const encodedFrameBytes = (frame: CoachRunFrame): number => {
  try {
    return Buffer.byteLength(JSON.stringify(frame) ?? '', 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

const startFailure = (): CoachRpcError =>
  new CoachRpcError({ code: 'start-failed', message: 'Unable to start the Coach run.' })

const runFailure = (): CoachRpcError =>
  new CoachRpcError({ code: 'run-failed', message: 'The Coach run stopped unexpectedly.' })

const overflowFailure = (): CoachRpcError =>
  new CoachRpcError({
    code: 'stream-overflow',
    message: 'Coach output exceeded the stream limit. Retry your message.',
  })

const unauthorized = (): CoachRpcError =>
  new CoachRpcError({ code: 'unauthorized', message: 'The Coach run is not owned by this connection.' })

const terminalEvent = (event: CoachEvent): boolean =>
  event.kind === 'error' || (event.kind === 'status' && event.state === 'done')

/** Create this layer once for each authenticated app RPC connection. */
export function coachHandlers<R>(capabilities: NativeCoachRunnerCapabilities<R>) {
  const ownedRuns = new Map<string, (message: string) => Effect.Effect<void, unknown, R>>()
  const completedRuns = new Set<string>()

  const rememberCompletedRun = (runId: string): void => {
    completedRuns.delete(runId)
    completedRuns.add(runId)
    if (completedRuns.size > COMPLETED_RUN_CAPACITY) {
      const oldest = completedRuns.values().next().value
      if (oldest !== undefined) completedRuns.delete(oldest)
    }
  }

  return CoachRpcGroup.toLayer({
    'coach:run': request =>
      Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* Queue.bounded<QueuedFrame>(queueCapacity)
          const started = yield* Deferred.make<CoachRunFrame, CoachRpcError>()
          const overflowed = yield* Deferred.make<undefined>()
          const cancellation = yield* Deferred.make<Exit.Exit<void, unknown>>()
          let queuedEvents = 0
          let queuedEventBytes = 0
          let runId: string | undefined
          const startFiber: { current?: Fiber.Fiber<void, unknown> } = {}
          let terminal = false
          let cancellationStarted = false

          const cancelOwned = (id: string): Effect.Effect<void, unknown, R> =>
            Effect.uninterruptible(
              Effect.suspend(() => {
                const resolve = (exit: Exit.Exit<void, unknown>) =>
                  Exit.isSuccess(exit) ? Effect.void : Effect.failCause(exit.cause)
                if (cancellationStarted) return Deferred.await(cancellation).pipe(Effect.flatMap(resolve))
                cancellationStarted = true
                return capabilities.cancel(id).pipe(
                  Effect.exit,
                  Effect.tap(exit => Deferred.succeed(cancellation, exit)),
                  Effect.flatMap(resolve),
                )
              }),
            )

          const offer = (frame: CoachRunFrame): void => {
            if (terminal) return
            const frameBytes = encodedFrameBytes(frame)
            const isTerminal = frame._tag === 'Event' && terminalEvent(frame.event)
            const overflowFrame = runId
              ? {
                  _tag: 'Event' as const,
                  runId,
                  event: { kind: 'error' as const, message: overflowFailure().message },
                }
              : undefined
            const overflowBytes = overflowFrame ? encodedFrameBytes(overflowFrame) : 0
            const hasEventCapacity = queuedEvents < EVENT_CAPACITY
            const hasByteCapacity =
              frameBytes <= MAX_SINGLE_EVENT_BYTES &&
              queuedEventBytes + frameBytes + (isTerminal ? 0 : OVERFLOW_FRAME_RESERVE_BYTES) <= MAX_PENDING_EVENT_BYTES
            if (hasEventCapacity && hasByteCapacity) {
              if (Queue.offerUnsafe(queue, frame)) {
                queuedEvents += 1
                queuedEventBytes += frameBytes
                if (isTerminal) {
                  terminal = true
                  Queue.offerUnsafe(queue, END)
                }
                return
              }
            }
            terminal = true
            if (runId && overflowFrame && overflowBytes <= OVERFLOW_FRAME_RESERVE_BYTES) {
              Queue.offerUnsafe(queue, overflowFrame)
              queuedEvents += 1
              queuedEventBytes += overflowBytes
              Queue.offerUnsafe(queue, END)
              Deferred.doneUnsafe(overflowed, Effect.succeed(undefined))
            } else {
              Deferred.doneUnsafe(started, Effect.fail(startFailure()))
            }
          }

          yield* Effect.addFinalizer(() =>
            Effect.gen(function* () {
              if (startFiber.current) yield* Fiber.interrupt(startFiber.current)
              if (runId) {
                const wasOwned = ownedRuns.has(runId)
                const stopped = yield* Effect.exit(cancelOwned(runId))
                if (wasOwned) {
                  if (Exit.isSuccess(stopped)) rememberCompletedRun(runId)
                  ownedRuns.delete(runId)
                }
                if (Exit.isFailure(stopped)) return yield* Effect.failCause(stopped.cause)
              }
            }).pipe(Effect.catchCause(() => Effect.void)),
          )

          yield* Effect.forkScoped(
            Deferred.await(overflowed).pipe(
              Effect.andThen(
                Deferred.await(started).pipe(
                  Effect.map(frame => frame.runId),
                  Effect.flatMap(cancelOwned),
                ),
              ),
              Effect.catchCause(() => Effect.void),
            ),
          )

          startFiber.current = yield* Effect.forkScoped(
            capabilities
              .start(
                request,
                (id, event) => {
                  runId = id
                  offer({ _tag: 'Event', runId: id, event })
                },
                id => {
                  runId = id
                },
              )
              .pipe(
                Effect.flatMap((result: CoachRunResult) => {
                  if (!result.ok) return Deferred.fail(started, startFailure())
                  const ownedRunId = result.runId
                  runId = ownedRunId
                  ownedRuns.set(ownedRunId, message => {
                    return cancelOwned(ownedRunId).pipe(
                      Effect.tap(() =>
                        Effect.sync(() =>
                          offer({ _tag: 'Event', runId: ownedRunId, event: { kind: 'error', message } }),
                        ),
                      ),
                    )
                  })
                  return Deferred.succeed(started, { _tag: 'Started', runId: ownedRunId })
                }),
                Effect.catchCause(cause =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Deferred.fail(started, startFailure()).pipe(Effect.asVoid),
                ),
              )
              .pipe(Effect.asVoid),
          )

          const eventStream = Stream.fromQueue(queue).pipe(
            Stream.mapEffect(frame =>
              Effect.sync(() => {
                if (frame !== END) {
                  queuedEvents = Math.max(0, queuedEvents - 1)
                  queuedEventBytes = Math.max(0, queuedEventBytes - encodedFrameBytes(frame))
                }
                return frame
              }),
            ),
            Stream.takeWhile(frame => frame !== END),
            Stream.map(frame => frame as CoachRunFrame),
          )
          return Stream.concat(Stream.fromEffect(Deferred.await(started)), eventStream)
        }),
      ),
    'coach:cancel': ({ runId }) => {
      const cancel = ownedRuns.get(runId)
      if (!cancel) return completedRuns.has(runId) ? Effect.void : Effect.fail(unauthorized())
      return cancel('cancelled').pipe(Effect.catchCause(() => Effect.fail(runFailure())))
    },
    'coach:reset': () =>
      Effect.uninterruptible(
        capabilities.reset.pipe(
          Effect.tap(() =>
            Effect.forEach([...ownedRuns.values()], cancel => cancel('cancelled'), {
              concurrency: 'unbounded',
              discard: true,
            }),
          ),
          Effect.catchCause(() => Effect.fail(runFailure())),
        ),
      ),
  })
}
