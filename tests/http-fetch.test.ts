import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it } from 'vitest'

import { HttpFetch, HttpFetchError } from '../src/main/pipeline/fetch-utils.js'

function okResponse(body: unknown = {}): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response
}

describe('HttpFetch (Effect-native fetch boundary)', () => {
  it('returns the Response on 200', async () => {
    const fetchImpl = (async () => okResponse({ rates: { EUR: 0.9 } })) as typeof fetch
    const response = await Effect.runPromise(
      Effect.gen(function* () {
        const http = yield* HttpFetch
        return yield* http.fetch('https://example.test/latest?from=USD&to=EUR')
      }).pipe(Effect.provide(HttpFetch.layerWithFetch(fetchImpl))),
    )
    expect(response.ok).toBe(true)
    expect(await response.json()).toEqual({ rates: { EUR: 0.9 } })
  })

  it('maps a network rejection to HttpFetchError reason network', async () => {
    const fetchImpl = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const http = yield* HttpFetch
        return yield* http.fetch('https://example.test/x')
      }).pipe(Effect.provide(HttpFetch.layerWithFetch(fetchImpl)), Effect.flip),
    )
    expect(error).toBeInstanceOf(HttpFetchError)
    expect(error.reason).toBe('network')
    expect(error.url).toBe('https://example.test/x')
  })

  it('maps an AbortError rejection to reason abort', async () => {
    const fetchImpl = (async () => {
      throw new DOMException('aborted', 'AbortError')
    }) as unknown as typeof fetch
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const http = yield* HttpFetch
        return yield* http.fetch('https://example.test/x')
      }).pipe(Effect.provide(HttpFetch.layerWithFetch(fetchImpl)), Effect.flip),
    )
    expect(error).toBeInstanceOf(HttpFetchError)
    expect(error.reason).toBe('abort')
  })

  it('times out via the Effect Clock (TestClock-controllable)', async () => {
    const neverFetch = (() => new Promise<Response>(() => {})) as typeof fetch
    const program = Effect.gen(function* () {
      const http = yield* HttpFetch
      return yield* http.fetch('https://example.test/slow', {}, 100)
    })
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(program.pipe(Effect.provide(HttpFetch.layerWithFetch(neverFetch))))
        yield* TestClock.adjust(200)
        return yield* Fiber.join(fiber).pipe(Effect.flip)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(error).toBeInstanceOf(HttpFetchError)
    expect(error.reason).toBe('timeout')
  })

  it('fiber interruption aborts the underlying fetch', async () => {
    let observedSignal: AbortSignal | undefined
    const hangingFetch = ((_: string, init: RequestInit = {}) => {
      observedSignal = init.signal ?? undefined
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    }) as typeof fetch

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          Effect.gen(function* () {
            const http = yield* HttpFetch
            return yield* http.fetch('https://example.test/hanging', {}, 8000)
          }).pipe(Effect.provide(HttpFetch.layerWithFetch(hangingFetch))),
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(observedSignal?.aborted).toBe(true)
  })
})
