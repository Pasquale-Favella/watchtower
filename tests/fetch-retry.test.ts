/**
 * Bounded transient retry on the four outbound fetch call sites (F15 / plan A1).
 *
 * The finding this closes: `HttpFetch` carried a written-down no-retry
 * contract — "callers already degrade to cached/snapshot fallbacks" — and the
 * consequence was never examined. One failed refresh left the last cached FX
 * rate in place for `FX_CACHE_TTL_MS` = 24h, so every currency figure in every
 * Section read wrong for a day off a two-second blip. The contract is now
 * "callers degrade to fallbacks AFTER a bounded retry".
 *
 * Everything here stubs at the `HttpFetch` / `layerWithFetch` seam. No test
 * opens a socket, and no test mutates `process.env`.
 *
 * Two independent proofs are used throughout:
 * - a `network` failure is retried exactly twice, then the caller's EXISTING
 *   degraded result is what comes back (nothing about the degrade changed);
 * - an `abort` failure is retried ZERO times, and the strongest form of that
 *   proof is that the program still completes under `TestClock` with no
 *   `TestClock.adjust` at all — a single scheduled retry delay would park the
 *   fiber on a virtual sleep forever.
 */
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Random from 'effect/Random'
import * as Schedule from 'effect/Schedule'
import type { SchemaError } from 'effect/Schema'
import * as TestClock from 'effect/testing/TestClock'
import type { SqlError } from 'effect/unstable/sql/SqlError'
import { afterEach, describe, expect, it } from 'vitest'

import { Env } from '../src/main/env.js'
import { type ActiveCurrency, FX_CACHE_TTL_MS, FxRates, refreshFxRateWithRates } from '../src/main/fx.js'
import {
  HttpFetch,
  HttpFetchError,
  isTransientFetchError,
  TRANSIENT_RETRY_RETRIES,
  transientRetrySchedule,
  worstCaseRetryWindowMs,
} from '../src/main/pipeline/fetch-utils.js'
import { takeQueuedLogRecords } from '../src/main/pipeline/file-errors.js'
import { PricingRefreshError, refreshPricingNowEffect } from '../src/main/pipeline/models.js'
import { fetchVercelGatewayReportEffect, type ReportRow } from '../src/main/pipeline/providers/vercel-gateway.js'
import type { DateRange } from '../src/main/pipeline/types.js'
import { fetchReleasesEffect, UpdateFetchError } from '../src/main/updates.js'
import type { CurrencyRate } from '../src/shared/schemas/ledger.js'

const RANGE: DateRange = {
  start: new Date('2026-01-01T00:00:00.000Z'),
  end: new Date('2026-01-31T00:00:00.000Z'),
}

/** Widest advance that covers `TRANSIENT_RETRY_BASE_MS * (2^2 - 1) = 750ms`
 *  plus the full ±20% jitter band (900ms), with headroom. Generous on
 *  purpose: `jittered` is `Math.random`-driven, so the exact virtual instant
 *  is not a fixed number. */
const RETRY_ENVELOPE_MS = 5_000

afterEach(() => {
  takeQueuedLogRecords()
})

/**
 * Forks `program`, advances the virtual clock past the retry envelope, and
 * joins — the shape every case below needs, extracted because getting it wrong
 * is SILENT: `TestClock` parks a fiber on its first scheduled retry delay
 * forever, so a window sized for ONE attempt turns a wrong assertion into a
 * 120s timeout instead of a failure.
 *
 * The caller still owns the `TestClock.layer()` provide (see the note on
 * `fxEffect` in tests/fx-effect.test.ts): the forked program and this `adjust`
 * must share ONE virtual clock, so the layer is provided around both, never
 * inside. The abort cases below deliberately skip this helper — completing with
 * no advance at all is their whole proof.
 */
function joinAfterAdvance<A, E, R>(program: Effect.Effect<A, E, R>, windowMs: number): Effect.Effect<A, E, R> {
  return Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(program)
    yield* TestClock.adjust(windowMs)
    return yield* Fiber.join(fiber)
  })
}

// ---------------------------------------------------------------------------
// Fakes. All at the `HttpFetch` / `layerWithFetch` seam — never the network.
// ---------------------------------------------------------------------------

function failingFetch(reason: 'network' | 'abort', message = 'offline'): { fetch: typeof fetch; calls: () => number } {
  let calls = 0
  const impl = (async () => {
    calls += 1
    throw reason === 'abort' ? new DOMException('aborted', 'AbortError') : new Error(message)
  }) as unknown as typeof fetch
  return { fetch: impl, calls: () => calls }
}

function jsonFetch(status: number, body: unknown): { fetch: typeof fetch; calls: () => number } {
  let calls = 0
  const impl = (async () => {
    calls += 1
    return { ok: status >= 200 && status < 300, status, json: async () => body }
  }) as unknown as typeof fetch
  return { fetch: impl, calls: () => calls }
}

/** Hangs forever, so the ONLY way out is the per-attempt Clock timeout —
 *  which is how a half-open network (the case `DEFAULT_FETCH_TIMEOUT_MS`
 *  exists for) reaches the retry policy. */
function hangingFetch(): { fetch: typeof fetch; calls: () => number } {
  let calls = 0
  const impl = (() => {
    calls += 1
    return new Promise<Response>(() => {})
  }) as typeof fetch
  return { fetch: impl, calls: () => calls }
}

/** In-memory `FxRates` port — no `LedgerStore`, no SQLite, no temp dir. */
function fakeRates(seed?: CurrencyRate): { saved: Map<string, CurrencyRate>; layer: Layer.Layer<FxRates> } {
  const saved = new Map<string, CurrencyRate>()
  if (seed) saved.set(seed.code, seed)
  return {
    saved,
    layer: FxRates.layerWithRates({
      getCurrencyRate: code => Effect.succeed(saved.get(code) ?? null),
      setCurrencyRate: rate =>
        Effect.sync(() => {
          saved.set(rate.code, rate)
        }),
      getDisplayCurrency: () => Effect.succeed('EUR'),
      setDisplayCurrency: () => Effect.void,
    }),
  }
}

function fxProgram(
  ratesLayer: Layer.Layer<FxRates>,
  fetchImpl: typeof fetch,
): Effect.Effect<ActiveCurrency, SqlError | SchemaError, never> {
  return refreshFxRateWithRates('EUR').pipe(
    Effect.provide(ratesLayer),
    Effect.provide(HttpFetch.layerWithFetch(fetchImpl)),
  )
}

// ---------------------------------------------------------------------------
// The policy itself — pinned without sleeping, like `respawnBackoffDelayForAttempt`.
// ---------------------------------------------------------------------------

describe('transientRetrySchedule (the shared bounded policy)', () => {
  it('retries exactly twice — three executions in total, then the last failure propagates', async () => {
    let attempts = 0
    const error = await Effect.runPromise(
      joinAfterAdvance(
        Effect.suspend((): Effect.Effect<never, HttpFetchError> => {
          attempts += 1
          return Effect.fail(new HttpFetchError({ reason: 'network', message: 'offline', url: 'https://x.test' }))
        }).pipe(Effect.retry({ schedule: transientRetrySchedule, while: isTransientFetchError }), Effect.flip),
        RETRY_ENVELOPE_MS,
      ).pipe(Effect.provide(TestClock.layer())),
    )
    expect(attempts).toBe(1 + TRANSIENT_RETRY_RETRIES)
    expect(error).toBeInstanceOf(HttpFetchError)
  })

  it('each delay is 250ms then 500ms scaled by jittered (±20%), so the whole envelope is sub-second', async () => {
    const bounds = await Effect.runPromise(
      Effect.gen(function* () {
        const step = yield* Schedule.toStep(transientRetrySchedule)
        const error = new HttpFetchError({ reason: 'network', message: 'x', url: 'https://x.test' })
        // `Schedule.exponential(250)` -> 250, 500; `jittered` scales [0.8, 1.2].
        const first = yield* step(0, error)
        const second = yield* step(0, error)
        return { first: Duration.toMillis(first[0]), second: Duration.toMillis(second[0]) }
      }),
    )
    expect(bounds.first).toBeGreaterThanOrEqual(200)
    expect(bounds.first).toBeLessThanOrEqual(300)
    expect(bounds.second).toBeGreaterThanOrEqual(400)
    expect(bounds.second).toBeLessThanOrEqual(600)
  })

  it('derives the retry window from nominal delays, so low jitter samples cannot undercount it', async () => {
    for (const [sample, expectedDelays] of [
      [0, [200, 400]],
      [1, [300, 600]],
    ] as const) {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const step = yield* Schedule.toStep(transientRetrySchedule)
          const error = new HttpFetchError({ reason: 'network', message: 'x', url: 'https://x.test' })
          const first = yield* step(0, error)
          const second = yield* step(0, error)
          return {
            sampledDelays: [Duration.toMillis(first[1]), Duration.toMillis(second[1])],
            window: yield* worstCaseRetryWindowMs(100),
          }
        }).pipe(
          Effect.provideService(Random.Random, {
            nextIntUnsafe: () => 0,
            nextDoubleUnsafe: () => sample,
          }),
        ),
      )

      expect(result.sampledDelays).toEqual(expectedDelays)
      expect(result.window).toBe(1_200)
      expect(result.window).toBeGreaterThanOrEqual(300 + result.sampledDelays[0] + result.sampledDelays[1])
    }
  })

  it('isTransientFetchError retries timeout and network, never abort', () => {
    const at = (reason: 'timeout' | 'abort' | 'network'): boolean =>
      isTransientFetchError(new HttpFetchError({ reason, message: 'x', url: 'u' }))
    expect(at('timeout')).toBe(true)
    expect(at('network')).toBe(true)
    expect(at('abort')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The policy is applied at the call sites; the service itself is untouched.
// ---------------------------------------------------------------------------

describe('HttpFetch stays single-attempt (the retry is a call-site property)', () => {
  it('one raw fetch on a network rejection — no retry inside the service', async () => {
    const { fetch, calls } = failingFetch('network')
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const http = yield* HttpFetch
        return yield* http.fetch('https://example.test/x')
      }).pipe(Effect.provide(HttpFetch.layerWithFetch(fetch)), Effect.flip),
    )
    expect(error).toBeInstanceOf(HttpFetchError)
    expect(calls()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// FX — the 24h stale-rate window (ADR 0009). The headline F15 consequence.
// ---------------------------------------------------------------------------

describe('refreshFxRateWithRates + transient retry', () => {
  it('a network failure retries twice, then degrades to the last cached rate with the SAME updatedAt', async () => {
    const seeded = await Effect.runPromise(
      Effect.gen(function* () {
        // 1. One good refresh pins the rate and its `updatedAt` at TestClock t0.
        const { saved, layer } = fakeRates()
        const good = jsonFetch(200, { rates: { EUR: 0.9 } })
        const first = yield* fxProgram(layer, good.fetch)
        expect(good.calls()).toBe(1)
        expect(first.rate).toBe(0.9)
        const pinnedUpdatedAt = saved.get('EUR')?.updatedAt
        expect(pinnedUpdatedAt).toBe(first.updatedAt)

        // 2. Past the 24h TTL the refresh is due again.
        yield* TestClock.adjust(FX_CACHE_TTL_MS + 1)

        // 3. The network is down. Two retries, then the SAME degrade as before
        //    the policy existed: last cached rate, original `updatedAt`.
        const down = failingFetch('network')
        const fallback = yield* joinAfterAdvance(fxProgram(layer, down.fetch), RETRY_ENVELOPE_MS)
        return { calls: down.calls(), fallback, pinnedUpdatedAt, stillCached: saved.get('EUR') }
      }).pipe(Effect.provide(TestClock.layer())),
    )
    // 1 attempt + 2 retries, then the fallback — not a hang, not a fourth try.
    expect(seeded.calls).toBe(1 + TRANSIENT_RETRY_RETRIES)
    expect(seeded.fallback).toMatchObject({ code: 'EUR', rate: 0.9, updatedAt: seeded.pinnedUpdatedAt })
    // The 24h window is untouched: the failed refresh persisted nothing, so the
    // cached rate (and its age) is exactly what it was before the blip.
    expect(seeded.stillCached).toMatchObject({ rate: 0.9, updatedAt: seeded.pinnedUpdatedAt })
  })

  it('a network failure retries twice with nothing cached, then falls back to USD rate 1', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { layer } = fakeRates()
        const down = failingFetch('network')
        const active = yield* joinAfterAdvance(fxProgram(layer, down.fetch), RETRY_ENVELOPE_MS)
        return { calls: down.calls(), active }
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(result.calls).toBe(1 + TRANSIENT_RETRY_RETRIES)
    expect(result.active.rate).toBe(1)
  })

  it('recovers inside the retry window: attempt 3 succeeds and persists the fresh rate', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const { saved, layer } = fakeRates()
        let calls = 0
        const flaky = (async () => {
          calls += 1
          if (calls < 3) throw new Error('blip')
          return { ok: true, status: 200, json: async () => ({ rates: { EUR: 0.85 } }) }
        }) as unknown as typeof fetch
        const active = yield* joinAfterAdvance(fxProgram(layer, flaky), RETRY_ENVELOPE_MS)
        return { calls, active, saved: saved.get('EUR') }
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(result.calls).toBe(3)
    expect(result.active.rate).toBe(0.85)
    expect(result.saved).toMatchObject({ rate: 0.85 })
  })

  it('an abort retries ZERO times: one fetch, and the program finishes with no clock advance at all', async () => {
    const { saved, layer } = fakeRates()
    const down = failingFetch('abort')
    // No `TestClock.adjust` anywhere in this program. If the retry policy ran,
    // it would park on a virtual sleep and this join would never resolve.
    const active = await Effect.runPromise(fxProgram(layer, down.fetch).pipe(Effect.provide(TestClock.layer())))
    expect(down.calls()).toBe(1)
    expect(active.rate).toBe(1)
    expect(saved.get('EUR')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Pricing — falls back to the on-disk cache for its TTL.
// ---------------------------------------------------------------------------

describe('refreshPricingNowEffect + transient retry', () => {
  it('a network failure retries twice, then raises the same typed fetch error', async () => {
    const down = failingFetch('network')
    const result = await Effect.runPromise(
      joinAfterAdvance(
        refreshPricingNowEffect().pipe(
          Effect.provide(HttpFetch.layerWithFetch(down.fetch)),
          Effect.provide(Env.layerWithValues({ vercelGatewayApiKey: null, pricingCacheTtlMs: Infinity })),
          Effect.flip,
        ),
        RETRY_ENVELOPE_MS,
      ).pipe(Effect.provide(TestClock.layer())),
    )
    expect(down.calls()).toBe(1 + TRANSIENT_RETRY_RETRIES)
    expect(result).toBeInstanceOf(PricingRefreshError)
    expect(result.reason).toBe('fetch')
  })

  it('an abort retries ZERO times and propagates on the first attempt', async () => {
    const down = failingFetch('abort')
    const error = await Effect.runPromise(
      refreshPricingNowEffect().pipe(
        Effect.provide(HttpFetch.layerWithFetch(down.fetch)),
        Effect.provide(Env.layerWithValues({ vercelGatewayApiKey: null, pricingCacheTtlMs: Infinity })),
        Effect.flip,
      ),
    )
    expect(down.calls()).toBe(1)
    expect(error).toBeInstanceOf(PricingRefreshError)
    expect(error.reason).toBe('fetch')
  })

  it('a non-2xx status is still NOT a failure: one fetch, typed http error, no retry', async () => {
    const bad = jsonFetch(503, {})
    const error = await Effect.runPromise(
      refreshPricingNowEffect().pipe(
        Effect.provide(HttpFetch.layerWithFetch(bad.fetch)),
        Effect.provide(Env.layerWithValues({ vercelGatewayApiKey: null, pricingCacheTtlMs: Infinity })),
        Effect.flip,
      ),
    )
    expect(bad.calls()).toBe(1)
    expect(error).toBeInstanceOf(PricingRefreshError)
    expect(error.reason).toBe('http')
  })
})

// ---------------------------------------------------------------------------
// Updates — `updates:check` reported "unable to check" for a single blip.
// ---------------------------------------------------------------------------

describe('fetchReleasesEffect + transient retry', () => {
  it('a network failure retries twice, then raises the same typed network error', async () => {
    const down = failingFetch('network')
    const error = await Effect.runPromise(
      joinAfterAdvance(
        fetchReleasesEffect().pipe(Effect.provide(HttpFetch.layerWithFetch(down.fetch)), Effect.flip),
        RETRY_ENVELOPE_MS,
      ).pipe(Effect.provide(TestClock.layer())),
    )
    expect(down.calls()).toBe(1 + TRANSIENT_RETRY_RETRIES)
    expect(error).toBeInstanceOf(UpdateFetchError)
    expect(error.reason).toBe('network')
  })

  it('an abort retries ZERO times and propagates on the first attempt', async () => {
    const down = failingFetch('abort')
    const error = await Effect.runPromise(
      fetchReleasesEffect().pipe(Effect.provide(HttpFetch.layerWithFetch(down.fetch)), Effect.flip),
    )
    expect(down.calls()).toBe(1)
    expect(error).toBeInstanceOf(UpdateFetchError)
  })

  it('a 404 is a real answer, not a transient failure: one fetch, typed http error, no retry', async () => {
    const missing = jsonFetch(404, {})
    const error = await Effect.runPromise(
      fetchReleasesEffect().pipe(Effect.provide(HttpFetch.layerWithFetch(missing.fetch)), Effect.flip),
    )
    expect(missing.calls()).toBe(1)
    expect(error).toBeInstanceOf(UpdateFetchError)
    expect(error.reason).toBe('http')
    expect(error.status).toBe(404)
  })

  it('recovers inside the retry window: attempt 3 succeeds and the release list comes back', async () => {
    let calls = 0
    const flaky = (async () => {
      calls += 1
      if (calls < 3) throw new Error('blip')
      return { ok: true, status: 200, json: async () => [{ tag_name: 'v0.2.0' }] }
    }) as unknown as typeof fetch
    const releases = await Effect.runPromise(
      joinAfterAdvance(
        fetchReleasesEffect().pipe(Effect.provide(HttpFetch.layerWithFetch(flaky))),
        RETRY_ENVELOPE_MS,
      ).pipe(Effect.provide(TestClock.layer())),
    )
    expect(calls).toBe(3)
    expect(releases).toEqual([{ tag_name: 'v0.2.0' }])
  })
})

// ---------------------------------------------------------------------------
// Vercel gateway — session discovery answered `[]` plus one warn per blip.
// ---------------------------------------------------------------------------

describe('fetchVercelGatewayReportEffect + transient retry', () => {
  it('a network failure retries twice, then returns [] with ONE `unreachable` warn', async () => {
    const down = failingFetch('network')
    const rows = await Effect.runPromise(
      joinAfterAdvance(
        fetchVercelGatewayReportEffect(RANGE).pipe(
          Effect.provide(HttpFetch.layerWithFetch(down.fetch)),
          Effect.provide(Env.layerWithGatewayKey('test-key')),
        ),
        RETRY_ENVELOPE_MS,
      ).pipe(Effect.provide(TestClock.layer())),
    )
    expect(down.calls()).toBe(1 + TRANSIENT_RETRY_RETRIES)
    expect(rows).toEqual([])
    // The log contract is byte-identical: one record, the same legacy code. The
    // retries are invisible to the sink, which is why this is worth pinning.
    expect(takeQueuedLogRecords().map(record => record.fields.code)).toEqual(['unreachable'])
  })

  it('an abort retries ZERO times and still answers [] with one `abort` warn', async () => {
    const down = failingFetch('abort')
    const rows = await Effect.runPromise(
      fetchVercelGatewayReportEffect(RANGE).pipe(
        Effect.provide(HttpFetch.layerWithFetch(down.fetch)),
        Effect.provide(Env.layerWithGatewayKey('test-key')),
      ),
    )
    expect(down.calls()).toBe(1)
    expect(rows).toEqual([])
    expect(takeQueuedLogRecords().map(record => record.fields.code)).toEqual(['abort'])
  })

  it('a non-2xx status is still NOT a failure: one fetch, one `http-<status>` warn, no retry', async () => {
    const bad = jsonFetch(500, {})
    const rows: ReportRow[] = await Effect.runPromise(
      fetchVercelGatewayReportEffect(RANGE).pipe(
        Effect.provide(HttpFetch.layerWithFetch(bad.fetch)),
        Effect.provide(Env.layerWithGatewayKey('test-key')),
      ),
    )
    expect(bad.calls()).toBe(1)
    expect(rows).toEqual([])
    expect(takeQueuedLogRecords().map(record => record.fields.code)).toEqual(['http-500'])
  })

  it('recovers inside the retry window: attempt 3 succeeds and the rows come back', async () => {
    let calls = 0
    const flaky = (async () => {
      calls += 1
      if (calls < 3) throw new Error('blip')
      return { ok: true, status: 200, json: async () => ({ results: [{ day: '2026-01-05', total_cost: 1.5 }] }) }
    }) as unknown as typeof fetch
    const rows = await Effect.runPromise(
      joinAfterAdvance(
        fetchVercelGatewayReportEffect(RANGE).pipe(
          Effect.provide(HttpFetch.layerWithFetch(flaky)),
          Effect.provide(Env.layerWithGatewayKey('test-key')),
        ),
        RETRY_ENVELOPE_MS,
      ).pipe(Effect.provide(TestClock.layer())),
    )
    expect(calls).toBe(3)
    expect(rows).toEqual([{ day: '2026-01-05', total_cost: 1.5 }])
    expect(takeQueuedLogRecords()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The `timeout` reason is retried too — it is the other half of the transient
// pair, and the half-open-network case (`DEFAULT_FETCH_TIMEOUT_MS`'s own
// documented reason to exist) is the one that most needs a second attempt.
//
// These four cases are ALSO the executable form of a follow-up owed by three
// pre-existing pins this slice does not own. Those pins sized their single
// `TestClock.adjust` window for ONE attempt and now park mid-retry:
//
//   tests/fx-effect.test.ts:167           timeoutMs 100  -> needs >=  900ms
//   tests/pricing-effect.test.ts:188      timeoutMs 100  -> needs >=  900ms
//   tests/vercel-gateway-effect.test.ts:124 default 8000 -> needs >= 24600ms
//   (tests/updates-effect.test.ts:111,203 default 15000 -> 60000ms still holds)
//
// Nothing about the behaviour each pin asserts changed — a timeout still
// degrades to the same fallback, persists nothing, and logs the same code —
// only the number of attempts behind it did, so widening those windows is a
// mechanical follow-up, not a behaviour decision.
// ---------------------------------------------------------------------------

describe('the timeout reason is retried, then degrades exactly as it did before', () => {
  it('FX: a hung fetch times out three times, then falls back to rate 1 without persisting', async () => {
    const { saved, layer } = fakeRates()
    const hang = hangingFetch()
    const active = await Effect.runPromise(
      joinAfterAdvance(
        refreshFxRateWithRates('EUR', { timeoutMs: 100 }).pipe(
          Effect.provide(layer),
          Effect.provide(HttpFetch.layerWithFetch(hang.fetch)),
        ),
        2_000,
      ).pipe(Effect.provide(TestClock.layer())),
    )
    expect(hang.calls()).toBe(1 + TRANSIENT_RETRY_RETRIES)
    expect(active.rate).toBe(1)
    expect(saved.get('EUR')).toBeUndefined()
  })

  it('pricing: a hung fetch times out three times, then raises the typed fetch error', async () => {
    const hang = hangingFetch()
    const error = await Effect.runPromise(
      joinAfterAdvance(
        refreshPricingNowEffect({ timeoutMs: 100 }).pipe(
          Effect.provide(HttpFetch.layerWithFetch(hang.fetch)),
          Effect.provide(Env.layerWithValues({ vercelGatewayApiKey: null, pricingCacheTtlMs: Infinity })),
          Effect.flip,
        ),
        2_000,
      ).pipe(Effect.provide(TestClock.layer())),
    )
    expect(hang.calls()).toBe(1 + TRANSIENT_RETRY_RETRIES)
    expect(error).toBeInstanceOf(PricingRefreshError)
    expect(error.reason).toBe('fetch')
  })

  it('updates: a hung fetch times out three times, then raises the typed timeout error', async () => {
    const hang = hangingFetch()
    const error = await Effect.runPromise(
      joinAfterAdvance(
        fetchReleasesEffect().pipe(Effect.provide(HttpFetch.layerWithFetch(hang.fetch)), Effect.flip),
        60_000,
      ).pipe(Effect.provide(TestClock.layer())),
    )
    expect(hang.calls()).toBe(1 + TRANSIENT_RETRY_RETRIES)
    expect(error).toBeInstanceOf(UpdateFetchError)
    expect(error.reason).toBe('timeout')
  })

  it('gateway: a hung fetch times out three times, then returns [] with ONE `timeout` warn', async () => {
    const hang = hangingFetch()
    const rows = await Effect.runPromise(
      joinAfterAdvance(
        fetchVercelGatewayReportEffect(RANGE).pipe(
          Effect.provide(HttpFetch.layerWithFetch(hang.fetch)),
          Effect.provide(Env.layerWithGatewayKey('test-key')),
        ),
        25_000,
      ).pipe(Effect.provide(TestClock.layer())),
    )
    expect(hang.calls()).toBe(1 + TRANSIENT_RETRY_RETRIES)
    expect(rows).toEqual([])
    expect(takeQueuedLogRecords().map(record => record.fields.code)).toEqual(['timeout'])
  })
})
