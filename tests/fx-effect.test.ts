import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it } from 'vitest'

import { type ActiveCurrency, FX_CACHE_TTL_MS, refreshFxRateEffect } from '../src/main/fx.js'
import { HttpFetch } from '../src/main/pipeline/fetch-utils.js'
import { LedgerStore } from '../src/main/store/ledger.js'

function makeStore(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'tr-fx-effect-'))
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

function runFx(
  store: LedgerStore,
  code: string,
  fetchImpl: typeof fetch,
  options: { now?: () => number; timeoutMs?: number } = {},
): Promise<ActiveCurrency> {
  return Effect.runPromise(
    refreshFxRateEffect(store, code, options).pipe(Effect.provide(HttpFetch.layerWithFetch(fetchImpl))),
  )
}

describe('refreshFxRateEffect (Effect-native FX boundary)', () => {
  it('fetches a missing rate and caches it', async () => {
    const store = makeStore()
    store.setDisplayCurrency('EUR')
    const active = await runFx(store, 'EUR', fakeFetchOk({ EUR: 0.9 }))
    expect(active).toMatchObject({ code: 'EUR', rate: 0.9 })
    expect(store.getCurrencyRate('EUR')).toMatchObject({ code: 'EUR', rate: 0.9 })
    store.close()
  })

  it('skips the network when the cached rate is fresh', async () => {
    const store = makeStore()
    store.setDisplayCurrency('EUR')
    store.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: new Date().toISOString() })
    let calls = 0
    const counting = (async () => {
      calls += 1
      return { ok: true, status: 200, json: async () => ({ rates: { EUR: 1.5 } }) }
    }) as unknown as typeof fetch
    await runFx(store, 'EUR', counting)
    expect(calls).toBe(0)
    expect(store.getCurrencyRate('EUR')?.rate).toBe(0.9)
    store.close()
  })

  it('falls back to the last cached rate on failure — never fails', async () => {
    const store = makeStore()
    const stale = new Date(Date.now() - (FX_CACHE_TTL_MS + 60_000)).toISOString()
    store.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: stale })
    const active = await runFx(store, 'EUR', throwingFetch())
    expect(active).toMatchObject({ rate: 0.9 })
    store.close()
  })

  it('falls back to rate 1 when nothing was cached and fetch fails', async () => {
    const store = makeStore()
    const active = await runFx(store, 'EUR', throwingFetch())
    expect(active.rate).toBe(1)
    expect(store.getCurrencyRate('EUR')).toBeNull()
    store.close()
  })

  it('rejects out-of-bounds rates and keeps the cached rate', async () => {
    const store = makeStore()
    await runFx(store, 'EUR', fakeFetchOk({ EUR: 9_999_999 }))
    expect(store.getCurrencyRate('EUR')).toBeNull()

    store.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: new Date().toISOString() })
    // force stale so it refetches
    const stale = new Date(Date.now() - (FX_CACHE_TTL_MS + 60_000)).toISOString()
    store.setCurrencyRate({ code: 'EUR', symbol: '€', rate: 0.9, updatedAt: stale })
    await runFx(store, 'EUR', fakeFetchOk({ EUR: 0 }))
    expect(store.getCurrencyRate('EUR')?.rate).toBe(0.9)
    store.close()
  })

  it('is a no-op for USD — no fetch', async () => {
    const store = makeStore()
    let calls = 0
    const counting = (async () => {
      calls += 1
      return { ok: true, status: 200, json: async () => ({}) }
    }) as unknown as typeof fetch
    const active = await runFx(store, 'USD', counting)
    expect(calls).toBe(0)
    expect(active).toEqual({ code: 'USD', symbol: '$', rate: 1 })
    store.close()
  })

  it('times out via TestClock and falls back without persisting', async () => {
    const store = makeStore()
    const neverFetch = (() => new Promise<Response>(() => {})) as typeof fetch
    const active = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          refreshFxRateEffect(store, 'EUR', { timeoutMs: 100 }).pipe(
            Effect.provide(HttpFetch.layerWithFetch(neverFetch)),
          ),
        )
        yield* TestClock.adjust(500)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(active.rate).toBe(1)
    expect(store.getCurrencyRate('EUR')).toBeNull()
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
        const fiber = yield* Effect.forkChild(
          refreshFxRateEffect(store, 'EUR', { timeoutMs: 8000 }).pipe(
            Effect.provide(HttpFetch.layerWithFetch(hangingFetch)),
          ),
        )
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
})
