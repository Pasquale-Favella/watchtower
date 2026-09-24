import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  getActiveCurrency,
  getFractionDigits,
  isRateStale,
  isValidCurrencyCode,
  listCurrencies,
  type RefreshFxRateEffectOptions,
  refreshFxRateWithRates,
  roundForActiveCurrency,
} from '../src/main/fx.js'
import { HttpFetch } from '../src/main/pipeline/fetch-utils.js'
import { LedgerStore } from '../src/main/store/ledger.js'

function makeStore(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'tr-fx-'))
  return new LedgerStore(join(dir, 'data.db'))
}

function fakeFetchOk(rates: Record<string, unknown>): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ rates }),
  })) as unknown as typeof fetch
}

function throwingFetch(message = 'offline'): typeof fetch {
  return (async () => {
    throw new Error(message)
  }) as unknown as typeof fetch
}

function fakeCountingFetch(rates: Record<string, unknown>): { fetch: typeof fetch; getCalls: () => number } {
  let calls = 0
  const inner = fakeFetchOk(rates)
  const fetch = (async (...args: Parameters<typeof fetch>) => {
    calls += 1
    return inner(...args)
  }) as typeof fetch
  return { fetch, getCalls: () => calls }
}

function fxEffect(
  store: LedgerStore,
  code: string,
  fetchImpl: typeof fetch,
  options: RefreshFxRateEffectOptions = {},
): Effect.Effect<ActiveCurrency, never, never> {
  return refreshFxRateWithRates(code, options).pipe(
    Effect.provide(FxRates.layerWithStore(store)),
    Effect.provide(HttpFetch.layerWithFetch(fetchImpl)),
  )
}

function runFx(
  store: LedgerStore,
  code: string,
  fetchImpl: typeof fetch,
  options: RefreshFxRateEffectOptions = {},
): Promise<ActiveCurrency> {
  return Effect.runPromise(fxEffect(store, code, fetchImpl, options))
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

describe('getActiveCurrency (the renderer-only read path, never fetches)', () => {
  it('defaults to USD when nothing has been configured or cached', () => {
    const store = makeStore()
    expect(getActiveCurrency(store)).toEqual({ code: 'USD', symbol: '$', rate: 1 })
    store.close()
  })

  it('uses the cached rate and symbol for the selected currency', () => {
    const store = makeStore()
    store.setDisplayCurrency('EUR')
    store.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: '2026-08-01T00:00:00.000Z' })
    const active = getActiveCurrency(store)
    expect(active).toEqual({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: '2026-08-01T00:00:00.000Z' })
    store.close()
  })

  it('falls back to the USD-equivalent rate for a never-cached currency (USD-only until a fetch succeeds)', () => {
    const store = makeStore()
    store.setDisplayCurrency('EUR')
    const active = getActiveCurrency(store)
    expect(active.code).toBe('EUR')
    expect(active.symbol).toBe('€')
    expect(active.rate).toBe(1)
    expect(active.updatedAt).toBeUndefined()
    store.close()
  })

  it('still serves a STALE cached rate rather than nothing (last successful rate wins)', () => {
    const store = makeStore()
    store.setDisplayCurrency('JPY')
    const stale = new Date(Date.now() - (FX_CACHE_TTL_MS + 60_000)).toISOString()
    store.setCurrencyRate({ code: 'JPY', symbol: '¥', rate: 150, updatedAt: stale })
    expect(getActiveCurrency(store).rate).toBe(150)
    store.close()
  })
})

describe('refreshFxRateWithRates (the main-process Frankfurter background job)', () => {
  it('fetches a missing rate and caches it into the FX side-table', async () => {
    const store = makeStore()
    store.setDisplayCurrency('EUR')
    const { fetch: counting, getCalls } = fakeCountingFetch({ EUR: 0.9 })
    const active = await runFx(store, 'EUR', counting)

    expect(getCalls()).toBe(1)
    expect(active).toMatchObject({ code: 'EUR', symbol: '€', rate: 0.9 })
    expect(store.getCurrencyRate('EUR')).toMatchObject({ code: 'EUR', rate: 0.9 })
    expect(getActiveCurrency(store).rate).toBe(0.9)
    store.close()
  })

  it('skips the network when the cached rate is fresh', async () => {
    const store = makeStore()
    store.setDisplayCurrency('EUR')
    store.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: new Date().toISOString() })
    const { fetch: counting, getCalls } = fakeCountingFetch({ EUR: 1.5 })
    await runFx(store, 'EUR', counting)

    expect(getCalls()).toBe(0)
    expect(getActiveCurrency(store).rate).toBe(0.9)
    store.close()
  })

  it('refetches a stale cached rate and replaces it', async () => {
    const store = makeStore()
    store.setDisplayCurrency('EUR')
    const stale = new Date(Date.now() - (FX_CACHE_TTL_MS + 60_000)).toISOString()
    store.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: stale })
    await runFx(store, 'EUR', fakeFetchOk({ EUR: 0.85 }))

    expect(store.getCurrencyRate('EUR')?.rate).toBe(0.85)
    store.close()
  })

  it('falls back to the last cached rate when the fetch fails (offline/blocked) — never throws', async () => {
    const store = makeStore()
    store.setDisplayCurrency('EUR')
    const stale = new Date(Date.now() - (FX_CACHE_TTL_MS + 60_000)).toISOString()
    store.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: stale })

    await expect(runFx(store, 'EUR', throwingFetch())).resolves.toMatchObject({ rate: 0.9 })
    expect(getActiveCurrency(store).rate).toBe(0.9)
    store.close()
  })

  it('falls back to USD (rate 1) when nothing was ever cached and the fetch fails', async () => {
    const store = makeStore()
    store.setDisplayCurrency('EUR')
    const active = await runFx(store, 'EUR', throwingFetch())
    expect(active.rate).toBe(1)
    expect(getActiveCurrency(store).rate).toBe(1)
    store.close()
  })

  it('fiber interruption does not persist a partial rate', async () => {
    const store = makeStore()
    let observedSignal: AbortSignal | undefined
    const hangingFetch = ((_: string, init: RequestInit = {}) => {
      observedSignal = init.signal ?? undefined
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
    }) as typeof fetch

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(fxEffect(store, 'EUR', hangingFetch, { timeoutMs: 8000 }))
        yield* Effect.yieldNow
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(observedSignal?.aborted).toBe(true)
    expect(store.getCurrencyRate('EUR')).toBeNull()
    store.close()
  })

  it('rejects out-of-bounds rates (parser bug / tampered response) and keeps the cached rate', async () => {
    const store = makeStore()
    store.setDisplayCurrency('EUR')
    await runFx(store, 'EUR', fakeFetchOk({ EUR: 9_999_999 }))
    expect(getActiveCurrency(store).rate).toBe(1)

    store.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: new Date().toISOString() })
    await runFx(store, 'EUR', fakeFetchOk({ EUR: 0 }))
    expect(getActiveCurrency(store).rate).toBe(0.9)
    store.close()
  })

  it('is a no-op for USD — no fetch, rate always 1', async () => {
    const store = makeStore()
    const { fetch: counting, getCalls } = fakeCountingFetch({ USD: 1 })
    await runFx(store, 'USD', counting)
    expect(getCalls()).toBe(0)
    expect(getActiveCurrency(store)).toEqual({ code: 'USD', symbol: '$', rate: 1 })
    store.close()
  })

  it('sanitizes an invalid code to USD', async () => {
    const store = makeStore()
    const { fetch: counting, getCalls } = fakeCountingFetch({ ZZZ: 1 })
    await runFx(store, 'ZZZ', counting)
    expect(getCalls()).toBe(0)
    store.close()
  })
})

describe('isRateStale', () => {
  const now = new Date('2026-08-05T12:00:00Z').getTime()
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
    // Small sub-cent costs keep precision instead of collapsing to zero
    // (converted 0.001 × 0.9 = 0.0009, shown to 4 places).
    expect(formatCost(0.001, EUR)).toBe('€0.0009')
  })

  it('getFractionDigits resolves zero-fraction currencies', () => {
    expect(getFractionDigits('USD')).toBe(2)
    expect(getFractionDigits('JPY')).toBe(0)
    expect(getFractionDigits('KRW')).toBe(0)
    expect(getFractionDigits('EUR')).toBe(2)
  })
})

describe('display-currency config (ADR 0009)', () => {
  it('defaults to USD and survives clear() (user setting, not scan data)', () => {
    const store = makeStore()
    expect(store.getDisplayCurrency()).toBe('USD')

    store.setDisplayCurrency('EUR')
    expect(store.getDisplayCurrency()).toBe('EUR')

    store.clear()
    expect(store.getDisplayCurrency()).toBe('EUR')
    store.close()
  })

  it('sanitizes invalid codes to USD', () => {
    const store = makeStore()
    store.setDisplayCurrency('eur') // lowercased is still a valid 3-letter code
    expect(store.getDisplayCurrency()).toBe('EUR')
    store.setDisplayCurrency('nope!')
    expect(store.getDisplayCurrency()).toBe('USD')
    store.close()
  })
})
