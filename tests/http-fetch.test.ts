import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as TestClock from 'effect/testing/TestClock'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import { describe, expect, it } from 'vitest'

import { HttpFetch, HttpFetchError } from '../src/main/pipeline/fetch-utils.js'

function okResponse(body: unknown = {}): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response
}

function fetchError(fetchImpl: typeof fetch, url = 'https://example.test/x'): Promise<HttpFetchError> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const http = yield* HttpFetch
      return yield* http.fetch(url)
    }).pipe(Effect.provide(HttpFetch.layerWithFetch(fetchImpl)), Effect.flip),
  )
}

// Live-layer runner: HttpFetch.layer over FetchHttpClient with an explicit
// Fetch transport. The Fetch reference caches its default process-wide, so
// tests must provide it per-effect — stubbing global fetch is not enough.
function provideLiveFetch<A, E>(effect: Effect.Effect<A, E, HttpFetch>, fetchImpl: typeof fetch): Effect.Effect<A, E> {
  return effect.pipe(Effect.provide(HttpFetch.layer), Effect.provideService(FetchHttpClient.Fetch, fetchImpl))
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
    const error = await fetchError(fetchImpl)
    expect(error).toBeInstanceOf(HttpFetchError)
    expect(error.reason).toBe('network')
    expect(error.url).toBe('https://example.test/x')
  })

  it('maps an AbortError rejection to reason abort', async () => {
    const fetchImpl = (async () => {
      throw new DOMException('aborted', 'AbortError')
    }) as unknown as typeof fetch
    const error = await fetchError(fetchImpl)
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

describe('HttpFetch.live (FetchHttpClient platform path)', () => {
  it('preserves the Response surface: status/ok/headers/body-bytes', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ hello: 'world' }), {
        status: 201,
        headers: { 'content-type': 'application/json', 'x-custom': 'yes' },
      })) as typeof fetch
    const response = await Effect.runPromise(
      provideLiveFetch(
        Effect.gen(function* () {
          const http = yield* HttpFetch
          return yield* http.fetch('https://example.test/live')
        }),
        fetchImpl,
      ),
    )
    expect(response.status).toBe(201)
    expect(response.ok).toBe(true)
    expect(response.headers.get('x-custom')).toBe('yes')
    expect(await response.json()).toEqual({ hello: 'world' })
  })

  it('does not fail on HTTP error statuses (callers check response.ok)', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 503 })) as typeof fetch
    const response = await Effect.runPromise(
      provideLiveFetch(
        Effect.gen(function* () {
          const http = yield* HttpFetch
          return yield* http.fetch('https://example.test/down')
        }),
        fetchImpl,
      ),
    )
    expect(response.ok).toBe(false)
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('boom')
  })

  it('maps a network rejection without retrying (single attempt)', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      throw new Error('offline')
    }) as unknown as typeof fetch
    const error = await Effect.runPromise(
      provideLiveFetch(
        Effect.gen(function* () {
          const http = yield* HttpFetch
          return yield* http.fetch('https://example.test/x')
        }),
        fetchImpl,
      ).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(HttpFetchError)
    expect(error.reason).toBe('network')
    expect(calls).toBe(1)
  })

  it('times out via the Effect Clock (TestClock-controllable)', async () => {
    const neverFetch = (() => new Promise<Response>(() => {})) as typeof fetch
    const program = Effect.gen(function* () {
      const http = yield* HttpFetch
      return yield* http.fetch('https://example.test/slow', {}, 100)
    })
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(provideLiveFetch(program, neverFetch))
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
          provideLiveFetch(
            Effect.gen(function* () {
              const http = yield* HttpFetch
              return yield* http.fetch('https://example.test/hanging', {}, 8000)
            }),
            hangingFetch,
          ),
        )
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(observedSignal?.aborted).toBe(true)
  })

  it('forwards method and headers to the underlying fetch', async () => {
    let observed: { url: unknown; init: RequestInit } | undefined
    const fetchImpl = ((url: string, init: RequestInit = {}) => {
      observed = { url, init }
      return Promise.resolve(new Response('{}', { status: 200 }))
    }) as typeof fetch
    await Effect.runPromise(
      provideLiveFetch(
        Effect.gen(function* () {
          const http = yield* HttpFetch
          return yield* http.fetch('https://example.test/report?x=1', {
            method: 'GET',
            headers: { Authorization: 'Bearer key', Accept: 'application/json' },
          })
        }),
        fetchImpl,
      ),
    )
    expect(String(observed?.url)).toBe('https://example.test/report?x=1')
    const sent = new Headers(observed?.init.headers)
    expect(sent.get('authorization')).toBe('Bearer key')
    expect(sent.get('accept')).toBe('application/json')
    expect(observed?.init.method).toBe('GET')
  })

  it('fails fast on a pre-aborted caller signal without calling fetch', async () => {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return new Response('{}', { status: 200 })
    }) as typeof fetch
    const error = await Effect.runPromise(
      provideLiveFetch(
        Effect.gen(function* () {
          const http = yield* HttpFetch
          return yield* http.fetch('https://example.test/x', { signal: AbortSignal.abort() })
        }),
        fetchImpl,
      ).pipe(Effect.flip),
    )
    expect(error).toBeInstanceOf(HttpFetchError)
    expect(error.reason).toBe('abort')
    expect(calls).toBe(0)
  })

  it('propagates a mid-flight caller abort as reason abort', async () => {
    let observedSignal: AbortSignal | undefined
    const hangingFetch = ((_: string, init: RequestInit = {}) => {
      observedSignal = init.signal ?? undefined
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    }) as typeof fetch
    const controller = new AbortController()
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          provideLiveFetch(
            Effect.gen(function* () {
              const http = yield* HttpFetch
              return yield* http.fetch('https://example.test/hanging', { signal: controller.signal }, 8000)
            }),
            hangingFetch,
          ),
        )
        yield* Effect.yieldNow
        yield* Effect.sync(() => controller.abort())
        return yield* Fiber.join(fiber).pipe(Effect.flip)
      }),
    )
    expect(error).toBeInstanceOf(HttpFetchError)
    expect(error.reason).toBe('abort')
    expect(observedSignal?.aborted).toBe(true)
  })
})
