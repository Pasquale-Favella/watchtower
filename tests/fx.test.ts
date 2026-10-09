import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import { describe, expect, it } from 'vitest'

import {
  type ActiveCurrency,
  convertCost,
  formatCost,
  FX_CACHE_TTL_MS,
  FxRates,
  getFractionDigits,
  isRateStale,
  isValidCurrencyCode,
  listCurrencies,
  type RefreshFxRateEffectOptions,
  refreshFxRateWithRates,
  roundForActiveCurrency,
} from '../src/main/fx.js'
import { HttpFetch } from '../src/main/pipeline/fetch-utils.js'
import { LedgerIngest } from '../src/main/store/ledger-repository.js'
import { type LedgerFixture, openLedgerFixture } from './fixtures/ledger-runtime.js'

function fakeFetchPayload(payload: unknown): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => payload })) as unknown as typeof fetch
}

function fakeFetchOk(rates: Record<string, unknown>): typeof fetch {
  return fakeFetchPayload({ rates })
}

function throwingFetch(message = 'offline'): typeof fetch {
  return (async () => {
    throw new Error(message)
  }) as unknown as typeof fetch
}

function fakeCountingFetch(rates: Record<string, unknown>): { fetch: typeof fetch; getCalls: () => number } {
  let calls = 0
  const inner = fakeFetchOk(rates)
  const fetchImpl: typeof fetch = async (input, init) => {
    calls += 1
    return inner(input, init)
  }
  return { fetch: fetchImpl, getCalls: () => calls }
}

function fxEffect(code: string, fetchImpl: typeof fetch, options: RefreshFxRateEffectOptions = {}) {
  return refreshFxRateWithRates(code, options).pipe(Effect.provide(HttpFetch.layerWithFetch(fetchImpl)))
}

function runFx(
  fixture: LedgerFixture,
  code: string,
  fetchImpl: typeof fetch,
  options: RefreshFxRateEffectOptions = {},
): Promise<ActiveCurrency> {
  return fixture.runtime.runPromise(fxEffect(code, fetchImpl, options))
}

function setRate(fixture: LedgerFixture, code: string, rate: number, updatedAt: string): Promise<void> {
  return fixture.runtime.runPromise(
    Effect.flatMap(FxRates, fx => fx.setCurrencyRate({ code, symbol: code === 'JPY' ? '¥' : '€', rate, updatedAt })),
  )
}

function readRate(fixture: LedgerFixture, code: string) {
  return fixture.runtime.runPromise(Effect.flatMap(FxRates, fx => fx.getCurrencyRate(code)))
}

function displayCurrency(fixture: LedgerFixture) {
  return fixture.runtime.runPromise(Effect.flatMap(FxRates, fx => fx.getDisplayCurrency()))
}

function setDisplayCurrency(fixture: LedgerFixture, code: string): Promise<void> {
  return fixture.runtime.runPromise(Effect.flatMap(FxRates, fx => fx.setDisplayCurrency(code)))
}

const EUR: ActiveCurrency = { code: 'EUR', symbol: '€', rate: 0.9 }
const JPY: ActiveCurrency = { code: 'JPY', symbol: '¥', rate: 150 }

describe('listCurrencies (ADR 0009: the full ISO 4217 selector list)', () => {
  it('offers the full runtime currency set — around 162 codes, not a reduced list', () => {
    const list = listCurrencies()
    expect(list.length).toBeGreaterThanOrEqual(150)
    expect(list.length).toBeLessThanOrEqual(200)
  })
  it('includes the common display currencies and is sorted by code', () => {
    const codes = listCurrencies().map(c => c.code)
    expect(codes).toContain('USD')
    expect(codes).toContain('EUR')
    expect(codes).toContain('JPY')
    expect(codes).toContain('AED')
    expect([...codes].sort()).toEqual(codes)
  })
  it('returns a display symbol for every entry', () => {
    for (const option of listCurrencies()) {
      expect(option.symbol.length).toBeGreaterThan(0)
      expect(isValidCurrencyCode(option.code)).toBe(true)
    }
  })
})

describe('FX configuration and cache (native worker runtime)', () => {
  it('defaults to USD and preserves the configured currency and cached rate across clear()', async () => {
    const fixture = openLedgerFixture()
    expect(await displayCurrency(fixture)).toBe('USD')
    await setDisplayCurrency(fixture, 'EUR')
    await setRate(fixture, 'EUR', 0.92, '2026-08-01T00:00:00.000Z')
    expect(await displayCurrency(fixture)).toBe('EUR')
    await fixture.runtime.runPromise(Effect.flatMap(LedgerIngest, ingest => ingest.clear()))
    expect(await displayCurrency(fixture)).toBe('EUR')
    expect(await readRate(fixture, 'EUR')).toMatchObject({ code: 'EUR', rate: 0.92 })
  })

  it('sanitizes invalid display codes to USD in the FX layer', async () => {
    const fixture = openLedgerFixture()
    await setDisplayCurrency(fixture, 'eur')
    expect(await displayCurrency(fixture)).toBe('EUR')
    await setDisplayCurrency(fixture, 'nope!')
    expect(await displayCurrency(fixture)).toBe('USD')
  })

  it('returns persisted fresh and stale cached rates without fetching', async () => {
    const fixture = openLedgerFixture()
    const timestamp = '2026-08-01T00:00:00.000Z'
    await setRate(fixture, 'EUR', 0.9, timestamp)
    expect(await readRate(fixture, 'EUR')).toEqual({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: timestamp })
    const stale = new Date(Date.now() - (FX_CACHE_TTL_MS + 60_000)).toISOString()
    await setRate(fixture, 'JPY', 150, stale)
    expect(await readRate(fixture, 'JPY')).toMatchObject({ rate: 150, updatedAt: stale })
  })
})

describe('refreshFxRateWithRates (the main-process Frankfurter background job)', () => {
  it('fetches a missing rate and caches it into the FX side-table', async () => {
    const fixture = openLedgerFixture()
    await setDisplayCurrency(fixture, 'EUR')
    const { fetch: counting, getCalls } = fakeCountingFetch({ EUR: 0.9 })
    const active = await runFx(fixture, 'EUR', counting)
    expect(getCalls()).toBe(1)
    expect(active).toMatchObject({ code: 'EUR', symbol: '€', rate: 0.9 })
    expect(await readRate(fixture, 'EUR')).toMatchObject({ code: 'EUR', rate: 0.9 })
  })

  it('skips the network when the cached rate is fresh', async () => {
    const fixture = openLedgerFixture()
    await setDisplayCurrency(fixture, 'EUR')
    await setRate(fixture, 'EUR', 0.9, new Date().toISOString())
    const { fetch: counting, getCalls } = fakeCountingFetch({ EUR: 1.5 })
    await runFx(fixture, 'EUR', counting)
    expect(getCalls()).toBe(0)
    expect(await readRate(fixture, 'EUR')).toMatchObject({ rate: 0.9 })
  })

  it('refetches a stale cached rate and replaces it', async () => {
    const fixture = openLedgerFixture()
    await setDisplayCurrency(fixture, 'EUR')
    await setRate(fixture, 'EUR', 0.9, new Date(Date.now() - (FX_CACHE_TTL_MS + 60_000)).toISOString())
    await runFx(fixture, 'EUR', fakeFetchOk({ EUR: 0.85 }))
    expect((await readRate(fixture, 'EUR'))?.rate).toBe(0.85)
  })

  it('falls back to the last cached rate when the fetch fails (offline/blocked) — never throws', async () => {
    const fixture = openLedgerFixture()
    await setDisplayCurrency(fixture, 'EUR')
    await setRate(fixture, 'EUR', 0.9, new Date(Date.now() - (FX_CACHE_TTL_MS + 60_000)).toISOString())
    await expect(runFx(fixture, 'EUR', throwingFetch())).resolves.toMatchObject({ rate: 0.9 })
  })

  it('falls back to USD (rate 1) when nothing was ever cached and the fetch fails', async () => {
    const fixture = openLedgerFixture()
    await setDisplayCurrency(fixture, 'EUR')
    expect((await runFx(fixture, 'EUR', throwingFetch())).rate).toBe(1)
    expect((await readRate(fixture, 'EUR'))?.rate).toBeUndefined()
  })

  it('fiber interruption does not persist a partial rate', async () => {
    const fixture = openLedgerFixture()
    let observedSignal: AbortSignal | undefined
    const hangingFetch = ((_: string, init: RequestInit = {}) => {
      observedSignal = init.signal ?? undefined
      return new Promise<Response>((_, reject) =>
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }),
      )
    }) as typeof fetch
    const exit = await fixture.runtime.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(fxEffect('EUR', hangingFetch, { timeoutMs: 8000 }))
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(observedSignal?.aborted).toBe(true)
    expect(await readRate(fixture, 'EUR')).toBeNull()
  })

  it('rejects out-of-bounds rates (parser bug / tampered response) and keeps the cached rate', async () => {
    const fixture = openLedgerFixture()
    await setDisplayCurrency(fixture, 'EUR')
    await runFx(fixture, 'EUR', fakeFetchOk({ EUR: 9_999_999 }))
    expect(await readRate(fixture, 'EUR')).toBeNull()
    await setRate(fixture, 'EUR', 0.9, new Date().toISOString())
    await runFx(fixture, 'EUR', fakeFetchOk({ EUR: 0 }))
    expect((await readRate(fixture, 'EUR'))?.rate).toBe(0.9)
  })

  it.each([
    ['missing rates', {}],
    ['null rates', { rates: null }],
    ['array rates', { rates: [0.9] }],
    ['string rates', { rates: 'invalid' }],
    ['missing requested currency', { rates: { USD: 1 } }],
    ['NaN', { rates: { EUR: Number.NaN } }],
    ['positive infinity', { rates: { EUR: Number.POSITIVE_INFINITY } }],
    ['negative infinity', { rates: { EUR: Number.NEGATIVE_INFINITY } }],
    ['string rate', { rates: { EUR: '0.9' } }],
    ['negative rate', { rates: { EUR: -0.1 } }],
    ['zero rate', { rates: { EUR: 0 } }],
    ['below minimum', { rates: { EUR: 0.0000999 } }],
    ['above maximum', { rates: { EUR: 1_000_001 } }],
  ])('falls back to the cached rate for %s', async (_label, payload) => {
    const fixture = openLedgerFixture()
    const stale = new Date(Date.now() - (FX_CACHE_TTL_MS + 60_000)).toISOString()
    await setRate(fixture, 'EUR', 0.9, stale)
    expect(await runFx(fixture, 'EUR', fakeFetchPayload(payload))).toMatchObject({ rate: 0.9 })
    expect((await readRate(fixture, 'EUR'))?.rate).toBe(0.9)
  })

  it('falls back when the JSON body is malformed', async () => {
    const fixture = openLedgerFixture()
    const stale = new Date(Date.now() - (FX_CACHE_TTL_MS + 60_000)).toISOString()
    await setRate(fixture, 'EUR', 0.9, stale)
    const malformedJson = (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('malformed JSON')
      },
    })) as unknown as typeof fetch
    expect(await runFx(fixture, 'EUR', malformedJson)).toMatchObject({ rate: 0.9 })
    expect((await readRate(fixture, 'EUR'))?.rate).toBe(0.9)
  })

  it.each([
    ['minimum', 0.0001],
    ['maximum', 1_000_000],
  ])('accepts the inclusive %s FX rate bound', async (_label, rate) => {
    const fixture = openLedgerFixture()
    expect(await runFx(fixture, 'EUR', fakeFetchOk({ EUR: rate }))).toMatchObject({ rate })
    expect((await readRate(fixture, 'EUR'))?.rate).toBe(rate)
  })

  it('ignores malformed values for currencies other than the requested one', async () => {
    const fixture = openLedgerFixture()
    expect(await runFx(fixture, 'EUR', fakeFetchOk({ EUR: 0.91, JPY: 'invalid' }))).toMatchObject({ rate: 0.91 })
    expect((await readRate(fixture, 'EUR'))?.rate).toBe(0.91)
  })

  it('is a no-op for USD — no fetch, rate always 1', async () => {
    const fixture = openLedgerFixture()
    const { fetch: counting, getCalls } = fakeCountingFetch({ USD: 1 })
    expect(await runFx(fixture, 'USD', counting)).toEqual({ code: 'USD', symbol: '$', rate: 1 })
    expect(getCalls()).toBe(0)
  })

  it('sanitizes an invalid fetch code to USD', async () => {
    const fixture = openLedgerFixture()
    const { fetch: counting, getCalls } = fakeCountingFetch({ ZZZ: 1 })
    await runFx(fixture, 'ZZZ', counting)
    expect(getCalls()).toBe(0)
  })
})

describe('isRateStale', () => {
  const now: number = new Date('2026-08-05T12:00:00Z').getTime()
  it('treats missing and unparsable timestamps as stale', () => {
    expect(isRateStale(undefined, now)).toBe(true)
    expect(isRateStale('not-a-date', now)).toBe(true)
  })
  it('treats rates younger than 24h as fresh and older as stale', () => {
    expect(isRateStale(new Date(now - 60_000).toISOString(), now)).toBe(false)
    expect(isRateStale(new Date(now - FX_CACHE_TTL_MS - 1).toISOString(), now)).toBe(true)
  })
})

describe('display-boundary conversion and formatting', () => {
  it('convertCost multiplies USD by the active rate without rounding', () => {
    expect(convertCost(100, EUR)).toBe(90)
    expect(convertCost(0.42, EUR)).toBeCloseTo(0.378, 6)
  })
  it('roundForActiveCurrency rounds to the currency natural digits (JPY/KRW = 0)', () => {
    expect(roundForActiveCurrency(90.49, EUR)).toBe(90.49)
    expect(roundForActiveCurrency(90.499, EUR)).toBe(90.5)
    expect(roundForActiveCurrency(150.4, JPY)).toBe(150)
  })
  it('formatCost renders the converted value with the right symbol and decimals', () => {
    expect(formatCost(100, EUR)).toBe('€90.00')
    expect(formatCost(1, JPY)).toBe('¥150')
    expect(formatCost(0.001, EUR)).toBe('€0.0009')
  })
  it('getFractionDigits resolves zero-fraction currencies', () => {
    expect(getFractionDigits('USD')).toBe(2)
    expect(getFractionDigits('JPY')).toBe(0)
    expect(getFractionDigits('KRW')).toBe(0)
    expect(getFractionDigits('EUR')).toBe(2)
  })
})
