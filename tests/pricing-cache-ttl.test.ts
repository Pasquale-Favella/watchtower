// The pricing cache must EXPIRE (ADR 0033).
//
// The bug this locks: `resolvePricingCacheTtlMs` returned `Infinity` for every
// input that was not a positive number, so the DEFAULT install shipped a
// `<cacheDir>/litellm-pricing.json` that could never go stale. There was no
// automatic refresh path and no recovery other than the manual
// `pricing:refresh` IPC, which means a machine whose first launch had no network
// kept whatever shipped in the bundled snapshot indefinitely. A price correction
// could only reach users through a release.
//
// `parseCachedPricingPayload` compares `Date.now() - timestamp > ttlMs`, so a
// finite TTL is what makes the fetch path reachable again. The two loader cases
// at the bottom of this file are the ones that prove it; everything above them
// asserts the parser's own contract, offline, against hand-written numbers.

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_PRICING_CACHE_TTL_MS, Env, resolvePricingCacheTtlMs } from '../src/main/env.js'
import { HttpFetch } from '../src/main/pipeline/fetch-utils.js'
import { getModelCosts, loadPricingEffect } from '../src/main/pipeline/models.js'

const MS_PER_HOUR = 60 * 60 * 1000

/**
 * The live `Env.layer` reading `WATCHTOWER_PRICING_TTL_HOURS` out of a faked
 * `ConfigProvider` rather than the real environment.
 *
 * `ConfigProvider.fromEnvRecord` is the sanctioned seam for this: `Config` reads
 * the `ConfigProvider` reference, and `fromEnvRecord` is a `ConfigProvider` over
 * an explicit record. So this exercises the real production wiring — live layer,
 * `Config.option`, `readEnvFieldLive`, the pure parser — with no
 * `process.env` mutation, which is the property the `Env` header comment claims
 * for the service.
 */
function readLiveEnv(record: Record<string, string | undefined>): Promise<Env['Service']> {
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* Env
    }).pipe(
      Effect.provide(Env.layer),
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord(record)),
    ),
  )
}

describe('resolvePricingCacheTtlMs', () => {
  it('converts a positive numeric string from hours to milliseconds', () => {
    expect(resolvePricingCacheTtlMs('2')).toBe(2 * MS_PER_HOUR)
    expect(resolvePricingCacheTtlMs('0.5')).toBe(0.5 * MS_PER_HOUR)
    expect(resolvePricingCacheTtlMs('72')).toBe(72 * MS_PER_HOUR)
  })

  it('falls back to the finite default for every value that is not a positive number', () => {
    // Absent, empty, unparseable, zero, negative and an explicit `Infinity` all
    // land on the same number. Pinned per-value rather than left incidental:
    // this is the branch that used to return `Infinity`, and each of these is a
    // way a user or a shell could have written the var.
    expect(resolvePricingCacheTtlMs(undefined)).toBe(DEFAULT_PRICING_CACHE_TTL_MS)
    expect(resolvePricingCacheTtlMs('')).toBe(DEFAULT_PRICING_CACHE_TTL_MS)
    expect(resolvePricingCacheTtlMs('nope')).toBe(DEFAULT_PRICING_CACHE_TTL_MS)
    expect(resolvePricingCacheTtlMs('0')).toBe(DEFAULT_PRICING_CACHE_TTL_MS)
    expect(resolvePricingCacheTtlMs('-2')).toBe(DEFAULT_PRICING_CACHE_TTL_MS)
    expect(resolvePricingCacheTtlMs('Infinity')).toBe(DEFAULT_PRICING_CACHE_TTL_MS)
    expect(resolvePricingCacheTtlMs('NaN')).toBe(DEFAULT_PRICING_CACHE_TTL_MS)
  })

  it('regression: an unset TTL is 24 hours, not Infinity (the cache-never-expires defect)', () => {
    // The exact failure mode, named. `Infinity` here means
    // `parseCachedPricingPayload` in `src/main/pipeline/models.ts` never rejects
    // a cache and `loadPricingEffect` never reaches `fetchAndCachePricingEffect`
    // — the first-launch-offline machine is stuck on the bundled snapshot
    // forever. 24h is long enough that a normal user is not re-fetching on every
    // launch and short enough that a vendor price correction lands in a day
    // without a release; it is also the interval the FX rates already use
    // (ADR 0009), so the app makes at most one pricing fetch per day.
    //
    // The number itself is pinned here; that it CHANGES BEHAVIOUR is proved by
    // the loader cases at the bottom of this file, which drive a real cache
    // file through `loadPricingEffect`. An assertion of the shape
    // `Date.now() - Date.now() > TTL` cannot fail however the parser regresses,
    // which is why there isn't one.
    expect(DEFAULT_PRICING_CACHE_TTL_MS).toBe(86_400_000)
    expect(DEFAULT_PRICING_CACHE_TTL_MS).toBe(24 * MS_PER_HOUR)
    expect(resolvePricingCacheTtlMs(undefined)).toBe(86_400_000)
    // And it is finite, which is the whole point.
    expect(Number.isFinite(DEFAULT_PRICING_CACHE_TTL_MS)).toBe(true)
  })

  it('regression: no input reaches Infinity, so expiry can never be disabled by accident', () => {
    // The old parser had a branch that returned `Infinity`; every spelling that
    // could reach it is checked, so a later "restore the opt-out" edit fails
    // here rather than silently re-arming the defect.
    for (const raw of [undefined, '', ' ', 'nope', '0', '-1', '-0', 'Infinity', 'NaN', 'null', '1e999']) {
      expect(Number.isFinite(resolvePricingCacheTtlMs(raw)), `${String(raw)} must not resolve to Infinity`).toBe(true)
    }
  })

  it('a large positive value is honoured rather than clamped back to the default', () => {
    // An operator who wants a long-lived offline cache still can, by asking for
    // it explicitly. The default is the default, not a ceiling.
    expect(resolvePricingCacheTtlMs('720')).toBe(720 * MS_PER_HOUR)
  })
})

describe('Env layer reads WATCHTOWER_PRICING_TTL_HOURS through Config', () => {
  it('serves the finite default when the var is absent', async () => {
    await expect(readLiveEnv({})).resolves.toEqual({
      vercelGatewayApiKey: null,
      pricingCacheTtlMs: 86_400_000,
    })
  })

  it('serves the override when the var is set', async () => {
    await expect(readLiveEnv({ WATCHTOWER_PRICING_TTL_HOURS: '6' })).resolves.toEqual({
      vercelGatewayApiKey: null,
      pricingCacheTtlMs: 6 * MS_PER_HOUR,
    })
  })

  it('serves the default for a value the parser rejects, not Infinity', async () => {
    // The live path must agree with the pure parser on the degenerate inputs, or
    // the parser's contract is not the layer's contract.
    for (const raw of ['nope', '0', '-2']) {
      const env = await readLiveEnv({ WATCHTOWER_PRICING_TTL_HOURS: raw })
      expect(env.pricingCacheTtlMs, `${raw} must not become Infinity`).toBe(86_400_000)
    }
  })

  it('leaves the service shape and the gateway key untouched', async () => {
    // The TTL change must not have widened or renamed the service. The gateway
    // key resolves in the same layer and keeps its `??` precedence.
    const env = await readLiveEnv({ AI_GATEWAY_API_KEY: 'primary-key', VERCEL_OIDC_TOKEN: 'fallback-key' })
    expect(Object.keys(env).sort()).toEqual(['pricingCacheTtlMs', 'vercelGatewayApiKey'])
    expect(env.vercelGatewayApiKey).toBe('primary-key')
    expect(env.pricingCacheTtlMs).toBe(86_400_000)
  })

  it('the layerWithValues fake still carries an explicit value unchanged', async () => {
    // The fake path other suites depend on: it bypasses the parser entirely, so
    // a pinned `Infinity` there still resolves as `Infinity`. That is what keeps
    // `tests/pricing-effect.test.ts` and `tests/db-worker.test.ts` green without
    // edits, and it is why the `Infinity` opt-out had to be removed from the
    // PARSER rather than from the fake.
    const env = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* Env
      }).pipe(Effect.provide(Env.layerWithValues({ vercelGatewayApiKey: null, pricingCacheTtlMs: Infinity }))),
    )
    expect(env.pricingCacheTtlMs).toBe(Infinity)
  })
})

// The number above only matters if it changes what the LOADER does, so the
// last two cases drive a real `<cacheDir>/litellm-pricing.json` through
// `loadPricingEffect` with the DEFAULT ttl — the unset-var case the defect was
// about, with no `layerWithValues` shortcut that bypasses the parser — and count
// the network calls. `tests/pricing-effect.test.ts` covers the same two paths
// with a pinned ttl; these are the ones that fail if the default regresses.
//
// The cache DIRECTORY still has to come from `process.env` (it is the
// `resolveCacheDir` seam, and there is no service for it), so it is set per case
// and removed in `afterEach` like the sibling suites do.
describe('the default TTL decides whether a disk cache is still live', () => {
  /** A cache file written `ageMs` ago, holding one model at `rate`. */
  function writeCache(dir: string, model: string, rate: number, ageMs: number): void {
    writeFileSync(
      join(dir, 'litellm-pricing.json'),
      JSON.stringify({
        timestamp: Date.now() - ageMs,
        data: {
          [model]: {
            inputCostPerToken: rate,
            outputCostPerToken: rate * 2,
            cacheWriteCostPerToken: 0,
            cacheReadCostPerToken: 0,
            webSearchCostPerRequest: 0.01,
            fastMultiplier: 1,
          },
        },
      }),
    )
  }

  /** A fetch that counts its calls, so "did it go to the network" is asserted
   *  rather than inferred from which model happens to resolve. */
  function countingFetch(models: Record<string, { input_cost_per_token: number; output_cost_per_token: number }>) {
    const state = {
      calls: 0,
      fetch: (async () => {
        state.calls += 1
        return { ok: true, status: 200, json: async () => models } as Response
      }) as unknown as typeof fetch,
    }
    return state
  }

  /** `loadPricingEffect` against the LIVE `Env.layer` with an explicit env
   *  record, so the ttl under test is whatever the PARSER makes of the record
   *  — no `layerWithValues` shortcut around it. The cache DIRECTORY still has
   *  to come from `process.env`, which is the `resolveCacheDir` seam. */
  async function loadFromDisk(fetchImpl: typeof fetch): Promise<void> {
    await Effect.runPromise(
      loadPricingEffect().pipe(
        Effect.provide(HttpFetch.layerWithFetch(fetchImpl)),
        Effect.provide(Env.layer),
        // No TTL var at all: the DEFAULT, which is the case the defect was in.
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnvRecord({})),
      ),
    )
  }

  afterEach(() => {
    delete process.env['WATCHTOWER_CACHE_DIR']
  })

  it('accepts a cache written inside the default window without going to the network', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tr-pricing-ttl-'))
    writeCache(dir, 'ttl-live-model', 1e-6, 60 * 60 * 1000)
    const upstream = countingFetch({
      'ttl-refetched-model': { input_cost_per_token: 1e-6, output_cost_per_token: 2e-6 },
    })
    process.env['WATCHTOWER_CACHE_DIR'] = dir
    await loadFromDisk(upstream.fetch)
    expect(upstream.calls).toBe(0)
    expect(getModelCosts('ttl-live-model')!.inputCostPerToken).toBe(1e-6)
  })

  it('refetches a cache older than the default, and the fetched prices win', async () => {
    // One second past the default window. Under the old `Infinity` default this
    // is the case that could not happen: the cache was accepted forever and the
    // fetch was unreachable, so a vendor price correction never landed.
    const dir = mkdtempSync(join(tmpdir(), 'tr-pricing-ttl-'))
    writeCache(dir, 'ttl-stale-model', 1e-6, DEFAULT_PRICING_CACHE_TTL_MS + 1_000)
    const upstream = countingFetch({
      'ttl-refetched-model': { input_cost_per_token: 5e-6, output_cost_per_token: 9e-6 },
    })
    process.env['WATCHTOWER_CACHE_DIR'] = dir
    await loadFromDisk(upstream.fetch)
    expect(upstream.calls).toBe(1)
    expect(getModelCosts('ttl-refetched-model')!.inputCostPerToken).toBe(5e-6)
    // The stale entry is gone rather than merged: the fetch replaced the cache,
    // which is what "revalidate" has to mean for a wholesale upstream table.
    expect(getModelCosts('ttl-stale-model')).toBeNull()
  })
})
