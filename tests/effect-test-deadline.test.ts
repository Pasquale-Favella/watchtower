import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it } from 'vitest'

import { runEffectTest } from './helpers/run-effect-test.js'

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
})
