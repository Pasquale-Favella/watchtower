import { clearTimeout, setTimeout } from 'node:timers'

import * as Effect from 'effect/Effect'

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
