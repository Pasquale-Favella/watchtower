import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as TestClock from 'effect/testing/TestClock'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import { describe, expect, it, vi } from 'vitest'

import { closeOperationalLog, FETCH_TIMEOUT_COUNTER, initOperationalLog } from '../src/main/operational-log.js'
import { HttpFetch, type HttpFetchCounters, HttpFetchError } from '../src/main/pipeline/fetch-utils.js'

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

describe('HttpFetch timeout counter (Wave 5, issue #148)', () => {
  type FiledCounter = { name: string; amount: number; fields: Record<string, unknown> }

  function makeFiledCounters(): { counters: HttpFetchCounters; filed: FiledCounter[] } {
    const filed: FiledCounter[] = []
    const counters: HttpFetchCounters = {
      incrementCounter: (name, amount = 1, fields = {}) =>
        Effect.sync(() => {
          filed.push({ name, amount, fields: { ...fields } })
        }),
    }
    return { counters, filed }
  }

  function hangingFetch(): typeof fetch {
    return (() => new Promise<Response>(() => {})) as typeof fetch
  }

  function slowFetchProgram(url = 'https://example.test/slow'): Effect.Effect<Response, HttpFetchError, HttpFetch> {
    return Effect.gen(function* () {
      const http = yield* HttpFetch
      return yield* http.fetch(url, {}, 100)
    })
  }

  function runTimeoutWithClock(effect: Effect.Effect<Response, HttpFetchError>): Promise<HttpFetchError> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(effect)
        yield* TestClock.adjust(200)
        return yield* Fiber.join(fiber).pipe(Effect.flip)
      }).pipe(Effect.provide(TestClock.layer())),
    )
  }

  it('files FETCH_TIMEOUT_COUNTER once per bespoke timeout via the injected counters seam', async () => {
    const { counters, filed } = makeFiledCounters()
    const error = await runTimeoutWithClock(
      slowFetchProgram().pipe(Effect.provide(HttpFetch.layerWithFetch(hangingFetch(), counters))),
    )
    expect(error).toBeInstanceOf(HttpFetchError)
    expect(error.reason).toBe('timeout')
    expect(error.message).toBe('fetch timed out after 100ms')
    expect(error.url).toBe('https://example.test/slow')
    // Reason-only at the seam — never the URL (untrusted input for the allowlist).
    expect(filed).toEqual([{ name: FETCH_TIMEOUT_COUNTER, amount: 1, fields: { reason: 'timeout' } }])
  })

  it('never files on abort or network paths (timeout-only)', async () => {
    const { counters, filed } = makeFiledCounters()
    const runWith = (fetchImpl: typeof fetch): Promise<HttpFetchError> =>
      Effect.runPromise(
        Effect.gen(function* () {
          const http = yield* HttpFetch
          return yield* http.fetch('https://example.test/x')
        }).pipe(Effect.provide(HttpFetch.layerWithFetch(fetchImpl, counters)), Effect.flip),
      )
    const abortError = await runWith((async () => {
      throw new DOMException('aborted', 'AbortError')
    }) as unknown as typeof fetch)
    const networkError = await runWith((async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch)
    expect(abortError.reason).toBe('abort')
    expect(networkError.reason).toBe('network')
    expect(filed).toEqual([])
  })

  it('a throwing counters sink never breaks the timeout error', async () => {
    const throwing: HttpFetchCounters = {
      incrementCounter: () =>
        Effect.sync(() => {
          throw new Error('sink boom')
        }),
    }
    const error = await runTimeoutWithClock(
      slowFetchProgram().pipe(Effect.provide(HttpFetch.layerWithFetch(hangingFetch(), throwing))),
    )
    expect(error).toBeInstanceOf(HttpFetchError)
    expect(error.reason).toBe('timeout')
    expect(error.message).toBe('fetch timed out after 100ms')
  })

  it('defaults to live-singleton delegation preserving the legacy timeout error with zero edits', async () => {
    // Single-arg `layerWithFetch(fake)` — the pre-slice call shape every
    // forbidden consumer keeps using. The singleton is closed here so the
    // default is a provable no-op that never throws.
    closeOperationalLog()
    const error = await runTimeoutWithClock(
      slowFetchProgram().pipe(Effect.provide(HttpFetch.layerWithFetch(hangingFetch()))),
    )
    expect(error).toBeInstanceOf(HttpFetchError)
    expect(error.reason).toBe('timeout')
    expect(error.message).toBe('fetch timed out after 100ms')
  })

  it('files FETCH_TIMEOUT_COUNTER on the platform path via the live singleton (allowlisted, no URL)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'watchtower-fetch-counter-'))
    const logDir = join(base, 'logs')
    try {
      await initOperationalLog({ logDir, isPackaged: true })
      const error = await runTimeoutWithClock(
        provideLiveFetch(slowFetchProgram('https://example.test/slow?secret=abc'), hangingFetch()),
      )
      expect(error).toBeInstanceOf(HttpFetchError)
      expect(error.reason).toBe('timeout')
      await vi.waitFor(() => {
        const files = readdirSync(logDir).filter(f => f.startsWith('operational'))
        const records = files
          .flatMap(file => {
            const text = readFileSync(join(logDir, file), 'utf8')
            return text
              .split('\n')
              .filter(l => l.trim().length > 0)
              .map(line => JSON.parse(line) as Record<string, unknown>)
          })
          .filter(record => record['event'] === FETCH_TIMEOUT_COUNTER)
        expect(records).toHaveLength(1)
        expect(records[0]).toMatchObject({ count: 1 })
        // Allowlist enforcement (verified, not widened): `reason` is not an
        // allowlisted key and the URL is never filed, so the file record is
        // event + count only — the key itself carries the timeout meaning.
        expect(records[0]).not.toHaveProperty('url')
        expect(records[0]).not.toHaveProperty('reason')
        expect(records[0]).not.toHaveProperty('message')
      })
    } finally {
      try {
        closeOperationalLog()
      } catch {
        /* not initialised */
      }
      rmSync(base, { recursive: true, force: true })
    }
  })
})
