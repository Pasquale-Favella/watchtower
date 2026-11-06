import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Pull from 'effect/Pull'
import * as Schema from 'effect/Schema'
import type * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import {
  defaultDeltaCoalescerConfig,
  type DeltaCoalescerConfig,
  deltaCoalescerConfigSchema,
  type DeltaCoalescerState,
  drain,
  nextDeadline,
  offer,
  tick,
} from '@/core/domain/execution/delta-coalescer.js'
import type { AgentDriverEvent } from '@/shared/schemas/execution.js'

export class CoalescedEventConsumerConfigError extends Schema.TaggedError<CoalescedEventConsumerConfigError>()(
  'CoalescedEventConsumerConfigError',
  { message: Schema.String },
) {}

const monotonicMillis = Effect.map(Clock.monotonicTimeNanos, nanos => Number(nanos / 1_000_000n))

/**
 * Consume and commit events in order. At most one upstream pull and one commit
 * are active at a time. The coalescer bounds pending text; it does not bound
 * events already held by the upstream source or replace durable persistence.
 */
export const consumeCoalescedAgentEvents = Effect.fn('consumeCoalescedAgentEvents')(function* <E, R, E2, R2>(
  stream: Stream.Stream<AgentDriverEvent, E, R>,
  commit: (event: AgentDriverEvent) => Effect.Effect<boolean, E2, R2>,
  config: Partial<DeltaCoalescerConfig> = {},
): Effect.fn.Return<void, E | E2 | CoalescedEventConsumerConfigError, Exclude<R | R2, Scope.Scope>> {
  const decoded = Schema.decodeUnknownResult(deltaCoalescerConfigSchema, { onExcessProperty: 'error' })({
    ...defaultDeltaCoalescerConfig,
    ...config,
  })
  if (decoded._tag === 'Failure') {
    return yield* new CoalescedEventConsumerConfigError({
      message: 'Delta coalescing configuration is invalid.',
    })
  }

  let state: DeltaCoalescerState = { config: decoded.success }

  const commitAll = Effect.fnUntraced(function* (events: ReadonlyArray<AgentDriverEvent>) {
    for (const event of events) {
      const shouldContinue = yield* commit(event)
      if (!shouldContinue) return false
    }
    return true
  })

  const flush = Effect.fnUntraced(function* () {
    const result = drain(state)
    state = result.state
    return yield* commitAll(result.flush)
  })

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const pull = yield* Stream.toPull(stream)
      let stopped = false
      let ended = false

      while (!stopped && !ended) {
        const pullFiber = yield* Effect.forkScoped(pull)
        let pullExit: Exit.Exit<ReadonlyArray<AgentDriverEvent>, E | import('effect/Cause').Done<void>> | undefined

        while (pullExit === undefined && !stopped) {
          const deadline = nextDeadline(state)
          if (deadline === undefined) {
            pullExit = yield* Fiber.await(pullFiber)
          } else {
            const now = yield* monotonicMillis
            const waited = yield* Effect.raceFirst(
              Fiber.await(pullFiber).pipe(Effect.map(exit => ({ _tag: 'pull' as const, exit }))),
              Effect.sleep(Math.max(0, deadline - now)).pipe(Effect.as({ _tag: 'deadline' as const })),
            )

            if (waited._tag === 'pull') {
              pullExit = waited.exit
            } else {
              const timed = tick(state, yield* monotonicMillis)
              state = timed.state
              stopped = !(yield* commitAll(timed.flush))
            }
          }
        }

        if (stopped || pullExit === undefined) continue

        if (Exit.isSuccess(pullExit)) {
          for (const event of pullExit.value) {
            const offered = offer(state, event, yield* monotonicMillis)
            state = offered.state
            if (!(yield* commitAll(offered.flush))) {
              stopped = true
              break
            }
          }
        } else {
          const completed = Pull.doneExitFromCause(pullExit.cause)
          yield* flush()
          if (Exit.isSuccess(completed)) {
            ended = true
          } else {
            return yield* Effect.failCause(completed.cause)
          }
        }
      }
    }),
  )
})
