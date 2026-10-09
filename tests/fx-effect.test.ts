import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it } from 'vitest'

import {
  type ActiveCurrency,
  FX_CACHE_TTL_MS,
  FxRates,
  type RefreshFxRateEffectOptions,
  refreshFxRateWithRates,
} from '../src/main/fx.js'
import { HttpFetch, worstCaseRetryWindowMs } from '../src/main/pipeline/fetch-utils.js'
import type { CurrencyRate } from '../src/shared/schemas/ledger.js'
import { type LedgerFixture, openLedgerFixture } from './fixtures/ledger-runtime.js'
import { runWithTestClockWindow } from './helpers/run-effect-test.js'

function fakeFetchOk(rates: Record<string, unknown>): typeof fetch {
  return (async () => ({ ok: true, status: 200, json: async () => ({ rates }) })) as unknown as typeof fetch
}

function throwingFetch(message = 'offline'): typeof fetch {
  return (async () => {
    throw new Error(message)
  }) as unknown as typeof fetch
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

function pinDisplayCurrency(fixture: LedgerFixture, code: string): Promise<void> {
  return fixture.runtime.runPromise(Effect.flatMap(FxRates, rates => rates.setDisplayCurrency(code)))
}

function readCurrencyRate(fixture: LedgerFixture, code: string): Promise<CurrencyRate | null> {
  return fixture.runtime.runPromise(Effect.flatMap(FxRates, rates => rates.getCurrencyRate(code)))
}

function makeFakeRates(): { saved: Map<string, CurrencyRate>; ratesLayer: Layer.Layer<FxRates> } {
  const saved = new Map<string, CurrencyRate>()
  let displayCurrency = 'EUR'
  const ratesLayer = FxRates.layerWithRates({
    getCurrencyRate: code => Effect.succeed(saved.get(code) ?? null),
    setCurrencyRate: rate =>
      Effect.sync(() => {
        saved.set(rate.code, rate)
      }),
    getDisplayCurrency: () => Effect.succeed(displayCurrency),
    setDisplayCurrency: code =>
      Effect.sync(() => {
        displayCurrency = code
      }),
  })
  return { saved, ratesLayer }
}

describe('refreshFxRateWithRates (Effect-native FX boundary)', () => {
  it('fetches a missing rate and caches it through the worker runtime', async () => {
    const fixture = openLedgerFixture()
    await pinDisplayCurrency(fixture, 'EUR')
    const active = await runFx(fixture, 'EUR', fakeFetchOk({ EUR: 0.9 }))
    expect(active).toMatchObject({ code: 'EUR', rate: 0.9 })
    expect(await readCurrencyRate(fixture, 'EUR')).toMatchObject({ code: 'EUR', rate: 0.9 })
  })

  it('skips the network when the cached rate is fresh', async () => {
    const fixture = openLedgerFixture()
    await pinDisplayCurrency(fixture, 'EUR')
    await fixture.runtime.runPromise(
      Effect.flatMap(FxRates, rates =>
        rates.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: new Date().toISOString() }),
      ),
    )
    let calls = 0
    const counting = (async () => {
      calls += 1
      return { ok: true, status: 200, json: async () => ({ rates: { EUR: 1.5 } }) }
    }) as unknown as typeof fetch
    await runFx(fixture, 'EUR', counting)
    expect(calls).toBe(0)
    expect((await readCurrencyRate(fixture, 'EUR'))?.rate).toBe(0.9)
  })

  it('falls back to the last cached rate on failure — never fails', async () => {
    const fixture = openLedgerFixture()
    const stale = new Date(Date.now() - (FX_CACHE_TTL_MS + 60_000)).toISOString()
    await fixture.runtime.runPromise(
      Effect.flatMap(FxRates, rates =>
        rates.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: stale }),
      ),
    )
    expect(await runFx(fixture, 'EUR', throwingFetch())).toMatchObject({ rate: 0.9 })
  })

  it('falls back to rate 1 when nothing was cached and fetch fails', async () => {
    const fixture = openLedgerFixture()
    expect((await runFx(fixture, 'EUR', throwingFetch())).rate).toBe(1)
    expect(await readCurrencyRate(fixture, 'EUR')).toBeNull()
  })

  it('rejects out-of-bounds rates and keeps the cached rate', async () => {
    const fixture = openLedgerFixture()
    await runFx(fixture, 'EUR', fakeFetchOk({ EUR: 9_999_999 }))
    expect(await readCurrencyRate(fixture, 'EUR')).toBeNull()
    const stale = new Date(Date.now() - (FX_CACHE_TTL_MS + 60_000)).toISOString()
    await fixture.runtime.runPromise(
      Effect.flatMap(FxRates, rates =>
        rates.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: stale }),
      ),
    )
    await runFx(fixture, 'EUR', fakeFetchOk({ EUR: 0 }))
    expect((await readCurrencyRate(fixture, 'EUR'))?.rate).toBe(0.9)
  })

  it('is a no-op for USD — no fetch', async () => {
    const fixture = openLedgerFixture()
    let calls = 0
    const counting = (async () => {
      calls += 1
      return { ok: true, status: 200, json: async () => ({}) }
    }) as unknown as typeof fetch
    expect(await runFx(fixture, 'USD', counting)).toEqual({ code: 'USD', symbol: '$', rate: 1 })
    expect(calls).toBe(0)
  })

  it('times out via TestClock and falls back without persisting', async () => {
    const fixture = openLedgerFixture()
    const neverFetch = (() => new Promise<Response>(() => {})) as typeof fetch
    const timeoutMs = 100
    const timed = Effect.gen(function* () {
      return yield* runWithTestClockWindow(
        fxEffect('EUR', neverFetch, { timeoutMs }),
        yield* worstCaseRetryWindowMs(timeoutMs),
      )
    }).pipe(Effect.provide(TestClock.layer()))
    const active = await fixture.runtime.runPromise(timed)
    expect(active.rate).toBe(1)
    expect(await readCurrencyRate(fixture, 'EUR')).toBeNull()
  })

  it('runs against a fake FxRates port with controlled persistence', async () => {
    const { saved, ratesLayer } = makeFakeRates()
    const active = await Effect.runPromise(
      refreshFxRateWithRates('EUR').pipe(
        Effect.provide(ratesLayer),
        Effect.provide(HttpFetch.layerWithFetch(fakeFetchOk({ EUR: 0.9 }))),
      ),
    )
    expect(active).toMatchObject({ code: 'EUR', rate: 0.9 })
    expect(saved.get('EUR')).toMatchObject({ code: 'EUR', rate: 0.9 })
    expect(saved.get('EUR')?.updatedAt).toBe(active.updatedAt)
  })

  it('TestClock governs staleness for the port-based core', async () => {
    const { saved, ratesLayer } = makeFakeRates()
    const program = Effect.gen(function* () {
      const first = yield* refreshFxRateWithRates('EUR').pipe(
        Effect.provide(ratesLayer),
        Effect.provide(HttpFetch.layerWithFetch(fakeFetchOk({ EUR: 0.9 }))),
      )
      expect(first.rate).toBe(0.9)
      let calls = 0
      const counting = (async () => {
        calls += 1
        return { ok: true, status: 200, json: async () => ({ rates: { EUR: 1.5 } }) }
      }) as unknown as typeof fetch
      const second = yield* refreshFxRateWithRates('EUR').pipe(
        Effect.provide(ratesLayer),
        Effect.provide(HttpFetch.layerWithFetch(counting)),
      )
      expect(calls).toBe(0)
      expect(second.rate).toBe(0.9)
      yield* TestClock.adjust(FX_CACHE_TTL_MS + 1)
      const third = yield* refreshFxRateWithRates('EUR').pipe(
        Effect.provide(ratesLayer),
        Effect.provide(HttpFetch.layerWithFetch(fakeFetchOk({ EUR: 0.85 }))),
      )
      expect(third.rate).toBe(0.85)
      expect(saved.get('EUR')?.rate).toBe(0.85)
    })
    await Effect.runPromise(program.pipe(Effect.provide(TestClock.layer())))
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
    expect(await readCurrencyRate(fixture, 'EUR')).toBeNull()
  })

  it('persists FX settings through the native worker runtime and config port', async () => {
    const fixture = openLedgerFixture()
    await fixture.runtime.runPromise(
      Effect.flatMap(FxRates, rates =>
        Effect.andThen(
          rates.setDisplayCurrency('EUR'),
          rates.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: '2026-08-01T00:00:00.000Z' }),
        ),
      ),
    )
    expect(await fixture.runtime.runPromise(Effect.flatMap(FxRates, rates => rates.getDisplayCurrency()))).toBe('EUR')
    expect(await readCurrencyRate(fixture, 'EUR')).toMatchObject({ code: 'EUR', rate: 0.9 })
  })

  it('sanitizes display codes in the native config layer', async () => {
    const fixture = openLedgerFixture()
    await pinDisplayCurrency(fixture, 'eur')
    expect(await fixture.runtime.runPromise(Effect.flatMap(FxRates, rates => rates.getDisplayCurrency()))).toBe('EUR')
    await pinDisplayCurrency(fixture, 'nope!')
    expect(await fixture.runtime.runPromise(Effect.flatMap(FxRates, rates => rates.getDisplayCurrency()))).toBe('USD')
  })
})
