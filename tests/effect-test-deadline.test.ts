import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it } from 'vitest'

import { runEffectTest, runWithTestClockWindow } from './helpers/run-effect-test.js'

describe('Effect test real-time deadline', () => {
  it('interrupts work parked on virtual time and runs its finalizer', async () => {
    let finalized = false
    const program = Effect.sleep('1 hour').pipe(
      Effect.ensuring(
        Effect.sync(() => {
          finalized = true
        }),
      ),
      Effect.provide(TestClock.layer()),
    )
    await expect(runEffectTest(program, { timeoutMs: 50, label: 'parked retry' })).rejects.toThrow(
      'parked retry exceeded its real-time deadline of 50ms',
    )
    await expect.poll(() => finalized).toBe(true)
  })

  it('returns the result and preserves an ordinary failure', async () => {
    await expect(runEffectTest(Effect.succeed(42))).resolves.toBe(42)
    await expect(runEffectTest(Effect.fail(new Error('expected failure')))).rejects.toThrow('expected failure')
  })

  it('rejects invalid deadlines', async () => {
    for (const timeoutMs of [0, -1, Infinity, NaN]) {
      await expect(runEffectTest(Effect.void, { timeoutMs })).rejects.toThrow(RangeError)
    }
  })

  it('waits through async setup and delayed retry sleeps until the work completes', async () => {
    const program = Effect.gen(function* () {
      yield* Effect.tryPromise(() => new Promise<void>(resolve => globalThis.setTimeout(resolve, 5)))
      yield* Effect.sleep(10)
      yield* Effect.tryPromise(() => new Promise<void>(resolve => globalThis.setTimeout(resolve, 5)))
      yield* Effect.sleep(10)
      return yield* Effect.clockWith(clock => Effect.sync(() => clock.currentTimeMillisUnsafe()))
    })

    await expect(
      runEffectTest(runWithTestClockWindow(program, 20).pipe(Effect.provide(TestClock.layer())), {
        timeoutMs: 500,
      }),
    ).resolves.toBe(20)
  })

  it('returns work that completes without using TestClock sleep', async () => {
    const program = Effect.succeed('complete')
    await expect(
      runEffectTest(runWithTestClockWindow(program, 100).pipe(Effect.provide(TestClock.layer()))),
    ).resolves.toBe('complete')
  })

  it('keeps a no-sleep hang under the real-time deadline', async () => {
    const program = Effect.never
    await expect(
      runEffectTest(runWithTestClockWindow(program, 100).pipe(Effect.provide(TestClock.layer())), {
        timeoutMs: 50,
        label: 'no-sleep work',
      }),
    ).rejects.toThrow('no-sleep work exceeded its real-time deadline of 50ms')
  })

  it('fails when a registered sleep exceeds its virtual-time window', async () => {
    const program = Effect.sleep(101)
    await expect(
      runEffectTest(runWithTestClockWindow(program, 100).pipe(Effect.provide(TestClock.layer()))),
    ).rejects.toThrow('Effect exceeded its registered TestClock window')
  })
})
