import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as TestClock from 'effect/testing/TestClock'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Env } from '../src/main/env.js'
import { HttpFetch, worstCaseRetryWindowMs } from '../src/main/pipeline/fetch-utils.js'
import {
  getModelCosts,
  loadPricingEffect,
  PricingRefreshError,
  refreshPricingNowEffect,
} from '../src/main/pipeline/models.js'
import { runEffectTest, runWithTestClockWindow } from './helpers/run-effect-test.js'

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

function fakeFetchOk(data: unknown): typeof fetch {
  return (async () => okResponse(data)) as unknown as typeof fetch
}

function throwingFetch(message = 'offline'): typeof fetch {
  return (async () => {
    throw new Error(message)
  }) as unknown as typeof fetch
}

function freshCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tr-pricing-effect-'))
  process.env['WATCHTOWER_CACHE_DIR'] = dir
  return dir
}

function pricingEnv(ttlMs: number = Infinity): ReturnType<typeof Env.layerWithValues> {
  return Env.layerWithValues({
    vercelGatewayApiKey: null,
    pricingCacheTtlMs: ttlMs,
  })
}

function runLoadPricing(fetchImpl: typeof fetch, timeoutMs?: number, ttlMs: number = Infinity): Promise<void> {
  const envLayer = pricingEnv(ttlMs)
  if (timeoutMs === undefined) {
    return Effect.runPromise(
      loadPricingEffect().pipe(Effect.provide(HttpFetch.layerWithFetch(fetchImpl)), Effect.provide(envLayer)),
    )
  }
  return Effect.runPromise(
    loadPricingEffect({ timeoutMs }).pipe(
      Effect.provide(HttpFetch.layerWithFetch(fetchImpl)),
      Effect.provide(envLayer),
    ),
  )
}

function runLoadPricingAt(fetchImpl: typeof fetch, ttlMs: number, nowMs: number): Promise<void> {
  return Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs)
      yield* loadPricingEffect()
    }).pipe(
      Effect.provide(TestClock.layer()),
      Effect.provide(HttpFetch.layerWithFetch(fetchImpl)),
      Effect.provide(pricingEnv(ttlMs)),
    ),
  )
}

function expectSnapshotMerged(): void {
  expect(getModelCosts('gpt-4o')).not.toBeNull()
}

afterEach(() => {
  // `WATCHTOWER_CACHE_DIR` stays via `process.env` until the startup-snapshot
  // design lands (later slice — explicitly NOT this one). TTL no longer
  // mutates env: it arrives via `Env.layerWithValues` fakes.
  delete process.env['WATCHTOWER_CACHE_DIR']
})

describe('pricing effects (Effect-native pricing boundary)', () => {
  it('cache-miss fetch populates the cache and merges the bundled snapshot', async () => {
    const dir = freshCacheDir()
    const upstream = {
      'effect-test-model-alpha': {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
      },
    }
    await runLoadPricing(fakeFetchOk(upstream))
    const fetched = getModelCosts('effect-test-model-alpha')
    expect(fetched).not.toBeNull()
    expect(fetched?.inputCostPerToken).toBeCloseTo(0.000001, 12)
    expect(fetched?.outputCostPerToken).toBeCloseTo(0.000002, 12)
    // Bundled snapshot still resolves through the merge.
    expectSnapshotMerged()
    // Write-through to the disk cache.
    expect(existsSync(join(dir, 'litellm-pricing.json'))).toBe(true)
  })

  it('fresh disk cache skips the network', async () => {
    const dir = freshCacheDir()
    const cachedCosts = {
      inputCostPerToken: 0.000005,
      outputCostPerToken: 0.00001,
      cacheWriteCostPerToken: 0.000006,
      cacheReadCostPerToken: 0.0000005,
      webSearchCostPerRequest: 0.01,
      fastMultiplier: 1,
    }
    writeFileSync(
      join(dir, 'litellm-pricing.json'),
      JSON.stringify({ timestamp: Date.now(), data: { 'cached-disk-model-beta': cachedCosts } }),
    )
    let calls = 0
    const counting = (async () => {
      calls += 1
      return okResponse({})
    }) as unknown as typeof fetch
    await runLoadPricing(counting)
    expect(calls).toBe(0)
    expect(getModelCosts('cached-disk-model-beta')).toMatchObject({
      inputCostPerToken: 0.000005,
    })
    expectSnapshotMerged()
  })

  it('uses the Effect Clock for pricing cache expiry and write timestamps', async () => {
    const dir = freshCacheDir()
    const nowMs = Date.parse('2026-10-14T12:00:00.000Z')
    const cachedCosts = {
      inputCostPerToken: 0.000005,
      outputCostPerToken: 0.00001,
      cacheWriteCostPerToken: 0,
      cacheReadCostPerToken: 0,
      fastMultiplier: 1,
    }
    const cachePath = join(dir, 'litellm-pricing.json')
    writeFileSync(cachePath, JSON.stringify({ timestamp: nowMs - 50, data: { 'clock-cached-model': cachedCosts } }))
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      return okResponse({
        'clock-fetched-model': { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
      })
    }) as unknown as typeof fetch

    await runLoadPricingAt(fetchImpl, 100, nowMs)
    expect(calls).toBe(0)
    expect(getModelCosts('clock-cached-model')).not.toBeNull()

    writeFileSync(cachePath, JSON.stringify({ timestamp: nowMs - 101, data: { 'clock-cached-model': cachedCosts } }))
    await runLoadPricingAt(fetchImpl, 100, nowMs)
    expect(calls).toBe(1)
    expect(JSON.parse(readFileSync(cachePath, 'utf8'))).toMatchObject({ timestamp: nowMs })
  })

  it('fetch failure falls back to the snapshot and never fails', async () => {
    freshCacheDir()
    // Fresh module graph: proves the fallback path itself merges the snapshot
    // rather than passing on leftover state from earlier tests.
    vi.resetModules()
    const freshModels = await import('../src/main/pipeline/models.js')
    const freshFetch = await import('../src/main/pipeline/fetch-utils.js')
    const freshEnv = await import('../src/main/env.js')
    await Effect.runPromise(
      freshModels.loadPricingEffect().pipe(
        Effect.provide(freshFetch.HttpFetch.layerWithFetch(throwingFetch())),
        Effect.provide(
          freshEnv.Env.layerWithValues({
            vercelGatewayApiKey: null,
            pricingCacheTtlMs: Infinity,
          }),
        ),
      ),
    )
    // Never fails: reaching here means no rejection. Snapshot still resolves.
    expect(freshModels.getModelCosts('gpt-4o')).not.toBeNull()
    expect(freshModels.getModelCosts('never-fetched-model-gamma')).toBeNull()
  })

  it('refreshPricingNowEffect propagates a typed fetch error', async () => {
    freshCacheDir()
    const error = await Effect.runPromise(
      refreshPricingNowEffect().pipe(
        Effect.provide(HttpFetch.layerWithFetch(throwingFetch())),
        Effect.provide(pricingEnv()),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(PricingRefreshError)
    expect(error._tag).toBe('PricingRefreshError')
    expect(error.reason).toBe('fetch')
  })

  it('times out via TestClock with fallback and no cache write', async () => {
    const dir = freshCacheDir()
    const neverFetch = (() => new Promise<Response>(() => {})) as typeof fetch
    await runEffectTest(
      Effect.gen(function* () {
        return yield* runWithTestClockWindow(
          loadPricingEffect({ timeoutMs: 100 }).pipe(
            Effect.provide(HttpFetch.layerWithFetch(neverFetch)),
            Effect.provide(pricingEnv()),
          ),
          yield* worstCaseRetryWindowMs(100),
        )
      }).pipe(Effect.provide(TestClock.layer())),
    )
    // Fallback to the snapshot, and the timed-out fetch never wrote the cache.
    expectSnapshotMerged()
    expect(existsSync(join(dir, 'litellm-pricing.json'))).toBe(false)
  })

  it('stale disk cache triggers a refetch', async () => {
    const dir = freshCacheDir()
    writeFileSync(
      join(dir, 'litellm-pricing.json'),
      JSON.stringify({ timestamp: Date.now() - 25 * 60 * 60 * 1000, data: {} }),
    )
    let calls = 0
    const counting = (async () => {
      calls += 1
      return okResponse({
        'stale-refetch-model-zeta': { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
      })
    }) as unknown as typeof fetch
    await runLoadPricing(counting, undefined, 24 * 60 * 60 * 1000)
    expect(calls).toBe(1)
    expect(getModelCosts('stale-refetch-model-zeta')).not.toBeNull()
  })

  it('refreshPricingNowEffect maps a non-2xx response to a typed http error', async () => {
    freshCacheDir()
    const badStatus = (async () => new Response('{}', { status: 500 })) as typeof fetch
    const error = await Effect.runPromise(
      refreshPricingNowEffect().pipe(
        Effect.provide(HttpFetch.layerWithFetch(badStatus)),
        Effect.provide(pricingEnv()),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(PricingRefreshError)
    expect(error.reason).toBe('http')
  })

  it('refreshPricingNowEffect maps a JSON failure to a typed decode error', async () => {
    freshCacheDir()
    let calls = 0
    const badJson = (async () => {
      calls += 1
      return new Response('not json', { status: 200 })
    }) as typeof fetch
    const error = await Effect.runPromise(
      refreshPricingNowEffect().pipe(
        Effect.provide(HttpFetch.layerWithFetch(badJson)),
        Effect.provide(pricingEnv()),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(PricingRefreshError)
    expect(error.reason).toBe('decode')
    expect(calls).toBe(1)
  })

  it('refreshPricingNowEffect maps a non-record JSON root to a typed decode error', async () => {
    freshCacheDir()
    const nullRoot = (async () => new Response('null', { status: 200 })) as typeof fetch
    const error = await Effect.runPromise(
      refreshPricingNowEffect().pipe(
        Effect.provide(HttpFetch.layerWithFetch(nullRoot)),
        Effect.provide(pricingEnv()),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(PricingRefreshError)
    expect(error.reason).toBe('decode')
  })

  it('refreshPricingNowEffect maps a cache-write failure to a typed cache error', async () => {
    const blocker = join(mkdtempSync(join(tmpdir(), 'tr-pricing-effect-')), 'blocker')
    writeFileSync(blocker, 'not a dir')
    process.env['WATCHTOWER_CACHE_DIR'] = blocker
    const upstream = {
      'effect-test-model-epsilon': { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
    }
    const error = await Effect.runPromise(
      refreshPricingNowEffect().pipe(
        Effect.provide(HttpFetch.layerWithFetch(fakeFetchOk(upstream))),
        Effect.provide(pricingEnv()),
        Effect.flip,
      ),
    )
    expect(error).toBeInstanceOf(PricingRefreshError)
    expect(error.reason).toBe('cache')
  })

  it('invalid upstream entries are skipped', async () => {
    freshCacheDir()
    const upstream = {
      'good-invalid-test-model-delta': {
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
      },
      'bad-missing-input-delta': {
        output_cost_per_token: 0.000002,
      },
      'bad-missing-output-delta': {
        input_cost_per_token: 0.000001,
      },
      'bad-negative-delta': {
        input_cost_per_token: -0.001,
        output_cost_per_token: 0.000002,
      },
      'bad-null-row-delta': null,
      'good-with-upstream-metadata-delta': {
        input_cost_per_token: 0.000003,
        output_cost_per_token: 0.000004,
        sample_spec: { note: 'unconsumed catalog metadata' },
      },
    }
    await runLoadPricing(fakeFetchOk(upstream))
    expect(getModelCosts('good-invalid-test-model-delta')).not.toBeNull()
    expect(getModelCosts('bad-missing-input-delta')).toBeNull()
    expect(getModelCosts('bad-missing-output-delta')).toBeNull()
    expect(getModelCosts('bad-negative-delta')).toBeNull()
    expect(getModelCosts('bad-null-row-delta')).toBeNull()
    expect(getModelCosts('good-with-upstream-metadata-delta')).not.toBeNull()
  })
})
