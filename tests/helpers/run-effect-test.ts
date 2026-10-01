import { clearTimeout, setTimeout } from 'node:timers'

import * as Clock from 'effect/Clock'
import * as Deferred from 'effect/Deferred'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Queue from 'effect/Queue'
import * as TestClock from 'effect/testing/TestClock'

/**
 * Drive registered TestClock sleeps in order, returning when the program
 * completes and failing if the next sleep exceeds the supplied virtual window.
 */
export const runWithTestClockWindow = Effect.fnUntraced(function* <A, E, R>(
  program: Effect.Effect<A, E, R>,
  duration: Duration.Input,
): Effect.fn.Return<A, E, R> {
  const testClock = yield* TestClock.testClockWith(Effect.succeed)
  const startTime = testClock.currentTimeMillisUnsafe()
  const windowMs = Duration.toMillis(Duration.fromInputUnsafe(duration))
  const sleeps = yield* Queue.unbounded<number>()
  const completed = yield* Deferred.make<void>()
  const observedClock: Clock.Clock = {
    ...testClock,
    sleep: sleepDuration =>
      Effect.gen(function* () {
        // startImmediately runs TestClock.sleep through its synchronous
        // queue insertion before returning, so the notification corresponds
        // to an actual registered deadline rather than an attempted sleep.
        const targetTime = testClock.currentTimeMillisUnsafe() + Duration.toMillis(sleepDuration)
        const sleeper = yield* Effect.forkChild(testClock.sleep(sleepDuration), { startImmediately: true })
        yield* Queue.offer(sleeps, targetTime)
        return yield* Fiber.join(sleeper)
      }),
  }
  const fiber = yield* Effect.forkChild(
    Effect.provideService(
      program.pipe(Effect.ensuring(Deferred.succeed(completed, undefined))),
      Clock.Clock,
      observedClock,
    ),
  )

  while (true) {
    const targetTime = yield* Effect.raceFirst(Queue.take(sleeps), Deferred.await(completed).pipe(Effect.as(null)))
    if (targetTime === null) {
      return yield* Fiber.join(fiber)
    }
    const elapsedMs = targetTime - startTime
    if (elapsedMs > windowMs) {
      return yield* Effect.die(new Error('Effect exceeded its registered TestClock window'))
    }
    const remainingMs = targetTime - testClock.currentTimeMillisUnsafe()
    if (remainingMs > 0) yield* testClock.adjust(remainingMs)
  }
})

/** The deadline uses real time even when the program provides TestClock. */
export async function runEffectTest<A, E>(
  program: Effect.Effect<A, E>,
  options: { timeoutMs?: number; label?: string } = {},
): Promise<A> {
  const timeoutMs = options.timeoutMs ?? 10_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Test deadline must be positive and finite')

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${options.label ?? 'Effect test'} exceeded its real-time deadline of ${timeoutMs}ms`))
      controller.abort()
    }, timeoutMs)
  })
  try {
    return await Promise.race([Effect.runPromise(program, { signal: controller.signal }), deadline])
  } finally {
    clearTimeout(timer)
  }
}
