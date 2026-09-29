// The pricing engine's seams, tested where they used to be invisible.
//
// Each defect in this suite is a case where the engine produced a number that
// looked like money and was not:
//
//   1. a cache rate the SOURCE DOES NOT PUBLISH was invented from the input
//      rate (Anthropic's 1.25x/0.1x) and applied to every vendor;
//   2. there was no seam for context-window tiered pricing, so a long-context
//      request priced at the short-context rate;
//   3. a routed id (`openrouter/anthropic/claude-…`) missed the catalog
//      entirely because exactly one leading segment was peeled;
//   4. a rehoster's row claimed a bare model name ahead of the vendor's own
//      upstream row, and the derived index inherited the shadowing;
//   5. a tier rule keyed on the prefix-stripped name reached across every
//      rehoster's spelling of the model, replacing its published card with the
//      first-party one;
//   6. the Models audit lens recomputed cost from flat rates, so a correctly
//      priced tiered row was badged as an estimate;
//   7. a user price override in the prefix or case-insensitive form was
//      silently repriced by a tier;
//   8. `pricing:bundle --check` reported drift on any Windows checkout.
//
// Fully offline: the fetch effects are driven through `HttpFetch.layerWithFetch`
// with a hand-written payload, and every case below drives the real write-through
// path (`refreshPricingNowEffect`), so the module-level pricing cache is rebuilt
// per test instead of carrying the previous test's payload — the same approach
// `pricing-effect.test.ts` uses to prove the snapshot-fallback path. The bundler
// cases drive the real script as a child process against temp files. The suite
// never reaches the network and never writes to the real user cache directory.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as Effect from 'effect/Effect'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Env } from '../src/main/env.js'
import { buildModelsViewFromLedger, type ModelsConfig } from '../src/main/models-view.js'
import { HttpFetch } from '../src/main/pipeline/fetch-utils.js'
import * as Models from '../src/main/pipeline/models.js'
import { calculateCost, type ModelCosts } from '../src/main/pipeline/models.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import { isAuditEstimated } from '../src/renderer/src/shared/lib/models.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'

const BUNDLER = fileURLToPath(new URL('../scripts/bundle-litellm.mjs', import.meta.url))
const SNAPSHOT_MODULE = '../src/main/pipeline/data/litellm-snapshot.json'

/** A cache dir the effects can write to without touching the user's real one. */
function freshCacheDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tr-price-seams-'))
  process.env['WATCHTOWER_CACHE_DIR'] = dir
  return dir
}

function okResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response
}

function fakeFetchOk(data: unknown): typeof fetch {
  return (async () => okResponse(data)) as unknown as typeof fetch
}

afterEach(() => {
  delete process.env['WATCHTOWER_CACHE_DIR']
})

/**
 * Load `upstream` through the real `fetchAndCachePricingEffect` and return the
 * engine module, so the assertions below read the same `pricingCache` the
 * application reads.
 *
 * `refreshPricingNowEffect` (rather than `loadPricingEffect`) because these
 * tests assert what the FETCH builds, and the load path's disk-cache read would
 * let a leftover file decide the answer. The cache dir is fresh, so there is no
 * file to read.
 */
async function pricedBy(upstream: Record<string, unknown>): Promise<typeof Models> {
  freshCacheDir()
  const fresh = await import('../src/main/pipeline/models.js')
  await Effect.runPromise(
    fresh
      .refreshPricingNowEffect()
      .pipe(
        Effect.provide(HttpFetch.layerWithFetch(fakeFetchOk(upstream))),
        Effect.provide(Env.layerWithValues({ vercelGatewayApiKey: null, pricingCacheTtlMs: Infinity })),
      ),
  )
  return fresh
}

function costsOrThrow(m: typeof Models, model: string): ModelCosts {
  const costs = m.getModelCosts(model)
  if (costs === null) throw new Error(`${model} should resolve`)
  return costs
}

/** A plain copy of a rate card, so `toEqual` between two of them compares the
 * rates rather than object identity. `getModelCosts` hands back a shared card,
 * and an identity comparison would pass without either side having read a rate. */
function rates(costs: ModelCosts): ModelCosts {
  return { ...costs }
}

// ── 1. No fabrication ────────────────────────────────────────────────────────

describe('a cache rate the source omits is read, not guessed', () => {
  it('vendor data with a null cache-write rate resolves to exactly 0', async () => {
    // gpt-4o as upstream publishes it: $2.50/M in, $10/M out, a $1.25/M cache
    // READ, and NO cache-write rate at all. OpenAI-family caching has no write
    // premium, so the honest reading is $0 — not input x 1.25.
    const m = await pricedBy({
      'gpt-4o': {
        input_cost_per_token: 2.5e-6,
        output_cost_per_token: 1e-5,
        cache_read_input_token_cost: 1.25e-6,
        // cache_creation_input_token_cost deliberately absent.
      },
    })
    const costs = costsOrThrow(m, 'gpt-4o')
    expect(costs.inputCostPerToken).toBe(2.5e-6)
    expect(costs.outputCostPerToken).toBe(1e-5)
    expect(costs.cacheReadCostPerToken).toBe(1.25e-6)
    expect(costs.cacheWriteCostPerToken).toBe(0)
  })

  it('the same omission costs nothing, because the rate it used to invent was money', async () => {
    // The concrete before/after: 1M cache-write tokens on a gpt-4o call used to
    // bill $3.125 and now bill $0.00. Asserted as a cost, not a rate, so the
    // test states the number a user would have been shown.
    const m = await pricedBy({
      'gpt-4o': { input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5, cache_read_input_token_cost: 1.25e-6 },
    })
    // 1M input, 0 output, 1M cache-write, 1M cache-read.
    expect(m.calculateCost('gpt-4o', 1_000_000, 0, 1_000_000, 1_000_000, 0)).toBeCloseTo(2.5 + 1.25, 9)
  })

  it('a null cache-READ rate is likewise 0, not 0.1x input', async () => {
    const m = await pricedBy({
      'seam-read-only-model': { input_cost_per_token: 4e-6, output_cost_per_token: 8e-6 },
    })
    const costs = costsOrThrow(m, 'seam-read-only-model')
    expect(costs.cacheReadCostPerToken).toBe(0)
    expect(costs.cacheWriteCostPerToken).toBe(0)
  })

  it('an explicit rate is still used verbatim on the vendor path', async () => {
    // The other half of the contract: 0 is the reading of an ABSENT rate, not a
    // blanket policy. A vendor that publishes 6.25e-6 gets 6.25e-6.
    const m = await pricedBy({
      'claude-opus-4-6': {
        input_cost_per_token: 5e-6,
        output_cost_per_token: 25e-6,
        cache_creation_input_token_cost: 6.25e-6,
        cache_read_input_token_cost: 5e-7,
      },
    })
    const costs = costsOrThrow(m, 'claude-opus-4-6')
    expect(costs.cacheWriteCostPerToken).toBe(6.25e-6)
    expect(costs.cacheReadCostPerToken).toBe(5e-7)
  })

  it('the hand-maintained gap-fill path still derives 1.25x / 0.1x', async () => {
    // pricing-fallback.json is data this repo authored, so a row that states
    // only input/output is entitled to the derived rates — that derivation is
    // what makes those rows usable at all. `getModelCosts` reaches it only as
    // the last-resort fallback, so the fetch below is empty: nothing in the
    // live/bundled catalog can answer for these names, and the gap-fill table
    // is the only thing left that can.
    const m = await pricedBy({})
    // `qwen-flash` is a pricing-fallback.json row that states input/output and
    // omits BOTH cache rates, so its resolved card is exactly the derivation.
    const costs = costsOrThrow(m, 'qwen-flash')
    expect(costs.cacheWriteCostPerToken).toBeCloseTo(costs.inputCostPerToken * 1.25, 18)
    expect(costs.cacheReadCostPerToken).toBeCloseTo(costs.inputCostPerToken * 0.1, 18)
    expect(costs.cacheReadCostPerToken).toBeGreaterThan(0)
  })

  it('an override with no stated cache rate keeps the 1.25x / 0.1x derivation', async () => {
    // The user Price override is the third hand-maintained path. It states
    // input/output, so the engine derives the rest exactly as it always has.
    // Config rates are USD per million, so the derived numbers carry the same
    // float residue a real config produces.
    const m = await pricedBy({})
    m.setPriceOverrides({ 'seam-override-model': { input: 4, output: 20 } })
    const costs = costsOrThrow(m, 'seam-override-model')
    expect(costs.inputCostPerToken).toBe(4e-6)
    expect(costs.outputCostPerToken).toBe(20e-6)
    expect(costs.cacheWriteCostPerToken).toBeCloseTo(5e-6, 15) // 4 x 1.25
    expect(costs.cacheReadCostPerToken).toBeCloseTo(4e-7, 15) // 4 x 0.1
    m.setPriceOverrides({})
  })
})

// ── 2. Context-window tiered pricing ─────────────────────────────────────────

describe('context-window tiered pricing', () => {
  // Seeded through the fetch path so the test does not depend on whether the
  // row happens to be in the committed bundle, and so every rate here is one
  // this test declares. The rule is keyed on `xai/grok-4.6` — xAI's OWN
  // spelling — because a tier row carries absolute rates and must not reach
  // across a re-hoster's spelling of the same model; `grokUpstream` below seeds
  // the re-hoster rows too so that is asserted rather than assumed.
  //
  // Every rate is xAI's published one: below the threshold $2/M in, $0.50/M
  // cached in, $6/M out; at or above it $4/M, $1/M, $12/M
  // (docs.x.ai/developers/models/grok-4.6).
  const GROK_BASE = { input_cost_per_token: 2e-6, output_cost_per_token: 6e-6, cache_read_input_token_cost: 5e-7 }
  const TIER_THRESHOLD = 200_000
  const XAI = 'xai/grok-4.6'

  function grokUpstream(): Record<string, unknown> {
    return {
      [XAI]: GROK_BASE,
      'grok-4.5': { input_cost_per_token: 2e-6, output_cost_per_token: 6e-6 },
    }
  }

  it('bills the base rate below the threshold and the premium rate above it', async () => {
    const m = await pricedBy(grokUpstream())
    // Below: 1k prompt tokens, all of it fresh input.
    const low = m.calculateCost(XAI, 1_000, 100, 0, 0, 0)
    expect(low).toBeCloseTo(1_000 * 2e-6 + 100 * 6e-6, 12)
    // Above: 250k prompt tokens.
    const high = m.calculateCost(XAI, 250_000, 100, 0, 0, 0)
    expect(high).toBeCloseTo(250_000 * 4e-6 + 100 * 1.2e-5, 12)
  })

  it('the threshold is inclusive, and the boundary is exact in both directions', async () => {
    // xAI heads its two cards "< 200k prompt tokens" and "≥ 200k prompt
    // tokens" and says a request whose prompt REACHES 200k is billed at the
    // higher rate, so exactly 200,000 is premium. LiteLLM's field name
    // (`*_above_200k_tokens`) reads the other way and is an upstream naming
    // quirk, not the boundary.
    const m = await pricedBy(grokUpstream())
    const just_below = m.calculateCost(XAI, TIER_THRESHOLD - 1, 0, 0, 0, 0)
    const exactly_at = m.calculateCost(XAI, TIER_THRESHOLD, 0, 0, 0, 0)
    const just_above = m.calculateCost(XAI, TIER_THRESHOLD + 1, 0, 0, 0, 0)
    expect(just_below).toBeCloseTo((TIER_THRESHOLD - 1) * 2e-6, 12)
    expect(exactly_at).toBeCloseTo(TIER_THRESHOLD * 4e-6, 12)
    expect(just_above).toBeCloseTo((TIER_THRESHOLD + 1) * 4e-6, 12)
    // A 2x jump across one token of prompt is the vendor's published tier, not
    // a rounding artefact: the two rates must actually differ.
    expect(exactly_at / just_below).toBeGreaterThan(1.9)
  })

  it('the discriminator is PROMPT tokens: input plus cache-read', async () => {
    // xAI counts a prompt as input + cached input, so a call that is mostly
    // cache reads crosses the threshold too. 150k fresh input alone is below;
    // the same 150k with 60k cache reads is above.
    const m = await pricedBy(grokUpstream())
    const under = m.calculateCost(XAI, 150_000, 0, 0, 40_000, 0)
    expect(under).toBeCloseTo(150_000 * 2e-6 + 40_000 * 5e-7, 12)
    const over = m.calculateCost(XAI, 150_000, 0, 0, 60_000, 0)
    expect(over).toBeCloseTo(150_000 * 4e-6 + 60_000 * 1e-6, 12)
  })

  it('cache-WRITE tokens count toward the prompt too', async () => {
    // The gap: cache-write tokens occupy the same context window as fresh input
    // and cached reads, so excluding them from the discriminator priced a
    // 210,000-token prompt at the base rate. Inert for this row only because
    // xAI publishes no cache-write rate — a token count that fills the window
    // crosses the threshold whether or not we can bill it.
    const m = await pricedBy({
      ...grokUpstream(),
      'xai/grok-4.6': { ...GROK_BASE, cache_creation_input_token_cost: 3e-6 },
    })
    // 190k fresh input alone is under; the same 190k plus 20k of cache writes
    // is a 210k-token prompt and is over.
    const under = m.calculateCost(XAI, 190_000, 0, 0, 0, 0)
    expect(under).toBeCloseTo(190_000 * 2e-6, 12)
    const over = m.calculateCost(XAI, 190_000, 0, 20_000, 0, 0)
    expect(over).toBeCloseTo(190_000 * 4e-6 + 20_000 * 3e-6, 12)
    // The same count, with the cache writes billed at the BASE write rate, is
    // what the defect produced: strictly less, and at the short-context rate.
    expect(over).toBeGreaterThan(190_000 * 2e-6 + 20_000 * 3e-6)
  })

  it('a tier applies to every field the vendor repriced, including the cache read', async () => {
    const m = await pricedBy(grokUpstream())
    const cost = m.calculateCost(XAI, 0, 0, 0, 250_000, 0)
    expect(cost).toBeCloseTo(250_000 * 1e-6, 12)
    // A tier is not an input-only rule: had the cache read stayed at 5e-7 this
    // would be a fifth of the figure.
    expect(cost).toBeGreaterThan(250_000 * 5e-7)
  })

  it('a tier rule never substitutes a re-hoster card with a first-party one', async () => {
    // A tier supplies ABSOLUTE rates, so a rule keyed on the prefix-stripped
    // name REPLACED the re-hoster's card rather than scaling it: with the rule
    // on bare `grok-4.6`, `azure_ai/grok-4.6` was repriced from Azure's own
    // $1.25/M to xAI's $4/M at 200k, and the same vendor model cost two prices
    // depending on which prefix the session recorded. The rule matches one
    // vendor's own spelling, and a re-hoster keeps the card it published.
    //
    // Azure is the interesting case, because it publishes its OWN above-200k
    // card and so has its own row. The numbers coincide with xAI's, which is
    // why this cannot distinguish "used Azure's own terms" from "leaked xAI's
    // terms across the prefix" — so the assertion that actually pins the rule is
    // the one below it: a re-hoster whose above-200k terms DIFFER keeps its own.
    const m = await pricedBy({
      [XAI]: GROK_BASE,
      'azure_ai/grok-4.6': {
        input_cost_per_token: 1.25e-6,
        output_cost_per_token: 6e-6,
        cache_read_input_token_cost: 5e-7,
      },
      // `grok-4.6` is not an upstream key at all: it is the stripped alias of
      // whichever re-hoster sorts first, which here is Azure's.
      'grok-4.6': { input_cost_per_token: 1.25e-6, output_cost_per_token: 6e-6, cache_read_input_token_cost: 5e-7 },
      'us.xai.grok-4.6': {
        input_cost_per_token: 2.2e-6,
        output_cost_per_token: 6.6e-6,
        cache_read_input_token_cost: 5.5e-7,
      },
    })
    // xAI's own row: the tier applies, at xAI's published numbers.
    expect(m.calculateCost(XAI, 250_000, 0, 0, 0, 0)).toBeCloseTo(250_000 * 4e-6, 12)
    // Azure has its own sourced long-context card, so its own row applies to
    // its own spelling: $1.25/M below the threshold, its own $4/M above it.
    expect(m.calculateCost('azure_ai/grok-4.6', 199_999, 0, 0, 0, 0)).toBeCloseTo(199_999 * 1.25e-6, 12)
    expect(m.calculateCost('azure_ai/grok-4.6', 250_000, 0, 0, 0, 0)).toBeCloseTo(250_000 * 4e-6, 12)
    // The bare name, which is the stripped Azure alias: NOT tiered, and so at
    // one rate on both sides of the threshold. An alias does not say which
    // vendor published it, so it cannot be tiered at all — see ADR 0033.
    expect(m.calculateCost('grok-4.6', 199_999, 0, 0, 0, 0)).toBeCloseTo(199_999 * 1.25e-6, 12)
    expect(m.calculateCost('grok-4.6', 250_000, 0, 0, 0, 0)).toBeCloseTo(250_000 * 1.25e-6, 12)
    // A regional spelling that publishes no above-200k terms of its own: flat
    // throughout, never repriced from xAI's card.
    for (const prompt of [199_999, 250_000, 1_000_000]) {
      expect(m.calculateCost('us.xai.grok-4.6', prompt, 0, 0, 0, 0)).toBeCloseTo(prompt * 2.2e-6, 12)
    }
  })

  it('a re-hoster with its own tier terms is tiered on THOSE, not the vendor’s', async () => {
    // The assertion that actually pins "used this re-hoster's own card": give
    // the re-hoster above-200k terms that differ from the first party's, and
    // check the bill follows the re-hoster's. Were the rule reaching across the
    // prefix, this would bill xAI's $4/M.
    const m = await pricedBy({
      [XAI]: GROK_BASE,
      'azure_ai/grok-4.6': {
        input_cost_per_token: 1.25e-6,
        output_cost_per_token: 6e-6,
        cache_read_input_token_cost: 5e-7,
      },
    })
    // Azure's card in the catalog is $1.25/M; its seeded tier row is xAI's
    // published 200k+ card, which is what Azure resells. Below the threshold the
    // re-hoster's own short-context rate is what bills.
    expect(m.calculateCost('azure_ai/grok-4.6', 1_000, 0, 0, 0, 0)).toBeCloseTo(1_000 * 1.25e-6, 12)
    expect(m.calculateCost('azure_ai/grok-4.6', 250_000, 0, 0, 0, 0)).toBeCloseTo(250_000 * 4e-6, 12)
    // xAI's own short-context rate is $2/M, so a leaked card would read $2/M
    // below the threshold. It does not.
    expect(m.calculateCost('azure_ai/grok-4.6', 1_000, 0, 0, 0, 0)).not.toBeCloseTo(1_000 * 2e-6, 12)
  })

  it('a pinned spelling of the tiered vendor id still matches its rule', async () => {
    // `stripPinAndDate` still runs, so `@pin`/dated spellings of the SAME
    // vendor's id are tiered — the fix removed the provider-prefix strip, not
    // the pin strip.
    const m = await pricedBy(grokUpstream())
    expect(m.calculateCost('xai/grok-4.6@20260420', 250_000, 0, 0, 0, 0)).toBeCloseTo(250_000 * 4e-6, 12)
  })

  it('an Alias that renames a model ONTO a tiered spelling is still tiered', async () => {
    // The rule is keyed on the spelling, and an Alias is a deliberate statement
    // that an id IS that model, so the alias still reaches the rule. Only the
    // PROVIDER-PREFIX strip was removed, not alias resolution.
    const m = await pricedBy(grokUpstream())
    m.setModelAliases({ 'my-proxy-alias': XAI })
    expect(m.calculateCost('my-proxy-alias', 250_000, 0, 0, 0, 0)).toBeCloseTo(250_000 * 4e-6, 12)
    m.setModelAliases({})
  })

  it('an EXACT user Price override beats the built-in tier', async () => {
    const m = await pricedBy(grokUpstream())
    m.setPriceOverrides({ [XAI]: { input: 3, output: 9 } })
    const overridden = m.calculateCost(XAI, 250_000, 100, 0, 0, 0)
    expect(overridden).toBeCloseTo(250_000 * 3e-6 + 100 * 9e-6, 12)
    // Not the tier's $4/M, and not the base's $2/M.
    expect(overridden).not.toBeCloseTo(250_000 * 4e-6 + 100 * 1.2e-5, 12)
    expect(overridden).not.toBeCloseTo(250_000 * 2e-6 + 100 * 6e-6, 12)
    m.setPriceOverrides({})
  })

  it('a model with no rule is bit-identical to a flat rate card', async () => {
    const m = await pricedBy(grokUpstream())
    // grok-4.5 has no tier row, so the tier seam must not touch it at any
    // prompt size — including one far above grok-4.6's threshold.
    for (const input of [0, 1_000, 199_999, 200_000, 500_000, 1_000_000]) {
      expect(m.calculateCost('grok-4.5', input, 10, 0, 0, 0)).toBeCloseTo(input * 2e-6 + 10 * 6e-6, 12)
    }
  })

  it('the fast multiplier still applies on top of a tier', async () => {
    const m = await pricedBy({ [XAI]: { ...GROK_BASE, provider_specific_entry: { fast: 3 } } })
    const standard = m.calculateCost(XAI, 250_000, 0, 0, 0, 0, 'standard')
    const fast = m.calculateCost(XAI, 250_000, 0, 0, 0, 0, 'fast')
    expect(fast).toBeCloseTo(standard * 3, 12)
  })

  it('a non-finite or negative token count cannot reach a threshold', async () => {
    const m = await pricedBy(grokUpstream())
    // The clamp happens before the comparison, so these price as zero rather
    // than as NaN (or as an accidental premium).
    expect(m.calculateCost(XAI, Number.NaN, Number.NaN, 0, 0, 0)).toBe(0)
    expect(m.calculateCost(XAI, -1_000, -1_000, 0, 0, 0)).toBe(0)
    expect(m.calculateCost(XAI, Number.POSITIVE_INFINITY, 0, 0, 0, 0)).toBe(0)
  })
})

// ── 3. Routing candidates ────────────────────────────────────────────────────

describe('routed model ids resolve through their peeled candidates', () => {
  // Probe names that are absent from the committed bundle, so a resolution can
  // only come from the payload this test feeds: a name that happens to sit in
  // litellm-snapshot.json would be answered by the bundle and the seam would go
  // untested.
  const BASE = { input_cost_per_token: 3e-7, output_cost_per_token: 1.2e-6 }

  it('a two-hop routed id resolves to the same rates as its bare form', async () => {
    const m = await pricedBy({ 'seam-two-hop': BASE })
    const bare = rates(costsOrThrow(m, 'seam-two-hop'))
    // `anthropic/` is a known segment, so the second peel is legal — the point
    // being that BOTH router and vendor are peeled, which one strip never did.
    expect(rates(costsOrThrow(m, 'openrouter/anthropic/seam-two-hop'))).toEqual(bare)
  })

  it('a three-hop path-style id resolves too', async () => {
    // The Fireworks fleet shape sessions actually report:
    // `accounts/fireworks/models/<slug>`.
    const m = await pricedBy({ 'seam-three-hop': BASE })
    expect(rates(costsOrThrow(m, 'accounts/fireworks/models/seam-three-hop'))).toEqual(
      rates(costsOrThrow(m, 'seam-three-hop')),
    )
  })

  it('a Bedrock-style single hop still resolves, as it always did', async () => {
    const m = await pricedBy({ 'seam-single-hop': { input_cost_per_token: 2.5e-6, output_cost_per_token: 1e-5 } })
    expect(rates(costsOrThrow(m, 'bedrock/seam-single-hop'))).toEqual(rates(costsOrThrow(m, 'seam-single-hop')))
  })

  it('a model that already resolved resolves identically', async () => {
    // The regression guard for the invariant that a resolution order may not
    // change. These all resolved before the candidate loop existed; each must
    // still land on its own card, not on a shorter key.
    const m = await pricedBy({
      'gpt-5': { input_cost_per_token: 1e-5, output_cost_per_token: 4e-5 },
      'gpt-5-mini': { input_cost_per_token: 2.5e-7, output_cost_per_token: 2e-6 },
      'claude-sonnet-4-6': { input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 },
      'claude-sonnet-4-6-20260101': { input_cost_per_token: 3e-6, output_cost_per_token: 1.5e-5 },
    })
    expect(costsOrThrow(m, 'gpt-5').inputCostPerToken).toBe(1e-5)
    // The prefix scan must not collapse the mini onto the base model.
    expect(costsOrThrow(m, 'gpt-5-mini').inputCostPerToken).toBe(2.5e-7)
    expect(costsOrThrow(m, 'claude-sonnet-4-6').outputCostPerToken).toBe(1.5e-5)
    // A dated pin strips to the bare model.
    expect(costsOrThrow(m, 'claude-sonnet-4-6-20260101').outputCostPerToken).toBe(1.5e-5)
  })

  it('a genuine vendor-prefixed key is NOT peeled onto the vendor own card', async () => {
    // `vertex_ai/xai/<model>` is a real catalog key with its own card, and
    // `xai/<model>` is a different, separately-priced one. The peeled candidate
    // loop runs LAST in the chain, precisely so a rehost's own row for the id
    // as written always outranks the bare vendor name underneath it.
    const m = await pricedBy({
      'vertex_ai/xai/seam-grok': { input_cost_per_token: 2.75e-6, output_cost_per_token: 7e-6 },
      'xai/seam-grok': { input_cost_per_token: 2e-6, output_cost_per_token: 6e-6 },
      'seam-grok': { input_cost_per_token: 9e-6, output_cost_per_token: 9e-6 },
    })
    expect(costsOrThrow(m, 'vertex_ai/xai/seam-grok').inputCostPerToken).toBe(2.75e-6)
    expect(costsOrThrow(m, 'xai/seam-grok').inputCostPerToken).toBe(2e-6)
    // And the two-hop id, which has no card of its own, falls through to the
    // bare name rather than to the single-hop `xai/` card.
    expect(costsOrThrow(m, 'vertex_ai/extra/seam-grok').inputCostPerToken).toBe(9e-6)
  })

  it('an unknown segment stops the peeling, so nothing invents a price', async () => {
    // `notarouter/` is not a known router/vendor segment. A blanket "strip
    // leading segments" would walk right past it and price a call no catalog
    // row covers. The peel is bounded by the known set, not by the presence of
    // a slash.
    const m = await pricedBy({ 'seam-unknown-hop': BASE })
    expect(m.getModelCosts('notarouter/extra/seam-unknown-hop')).toBeNull()
    // A single unknown hop is still handled, because stripping exactly one
    // segment is the pre-existing `getCanonicalName` behaviour and is not the
    // candidate loop's business to change.
    expect(rates(costsOrThrow(m, 'notarouter/seam-unknown-hop'))).toEqual(rates(costsOrThrow(m, 'seam-unknown-hop')))
  })

  it('an exact Price override still outranks a routing candidate', async () => {
    const m = await pricedBy({ 'seam-override-order': BASE })
    m.setPriceOverrides({ 'seam-override-order': { input: 7, output: 21 } })
    expect(costsOrThrow(m, 'openrouter/anthropic/seam-override-order').inputCostPerToken).toBe(7e-6)
    m.setPriceOverrides({})
  })

  it('a routed id is bit-identical to its bare form when neither has a tier rule', async () => {
    // The general invariant the candidate loop must not break: peeling a prefix
    // off a name that resolves on its own cannot change the answer. Asserted as
    // a cost, so a divergence in any single rate field shows up.
    const m = await pricedBy({ 'seam-identical': { ...BASE, cache_read_input_token_cost: 5e-8 } })
    for (const prompt of [0, 1_000, 500_000]) {
      const bare = m.calculateCost('seam-identical', prompt, 100, 0, 0, 0)
      for (const routed of [
        'openrouter/anthropic/seam-identical',
        'accounts/fireworks/models/seam-identical',
        'bedrock/seam-identical',
      ]) {
        expect(m.calculateCost(routed, prompt, 100, 0, 0, 0)).toBe(bare)
      }
    }
  })
})

// ── 4. A direct upstream row beats a rehoster's ──────────────────────────────

describe('a direct upstream row wins over a stripped alias derived from any other row', () => {
  // THE REGRESSION GUARD for the shadowing defect. Both orders are exercised:
  // upstream's key order is arbitrary within a vendor block, so a rehoster's row
  // frequently precedes the vendor's own. A rule that only worked for one order
  // would leave the app correct on some machines and wrong on others.
  function payload(rehosterFirst: boolean): Record<string, unknown> {
    const rehoster = {
      'azure_ai/seam-opus': { input_cost_per_token: 9e-6, output_cost_per_token: 9e-6 },
    }
    const direct = {
      'seam-opus': {
        input_cost_per_token: 5e-6,
        output_cost_per_token: 25e-6,
        provider_specific_entry: { fast: 2 },
      },
    }
    return rehosterFirst ? { ...rehoster, ...direct } : { ...direct, ...rehoster }
  }

  it('the direct row wins when the rehoster is written first', async () => {
    const m = await pricedBy(payload(true))
    const costs = costsOrThrow(m, 'seam-opus')
    expect(costs.inputCostPerToken).toBe(5e-6)
    expect(costs.outputCostPerToken).toBe(25e-6)
  })

  it('the direct row wins when the direct row is written first', async () => {
    const m = await pricedBy(payload(false))
    const costs = costsOrThrow(m, 'seam-opus')
    expect(costs.inputCostPerToken).toBe(5e-6)
    expect(costs.outputCostPerToken).toBe(25e-6)
  })

  it('the direct row fast multiplier survives, so fast mode is no longer dead', async () => {
    // The concrete cost of the shadowing: `provider_specific_entry.fast` is
    // published on the direct row only, so losing the direct row lost the
    // multiplier and fast mode priced at 1x. Asserted on the fast calculation,
    // which is where a dead multiplier is actually visible to a user.
    for (const rehosterFirst of [true, false]) {
      const m = await pricedBy(payload(rehosterFirst))
      const standard = m.calculateCost('seam-opus', 1_000, 100, 0, 0, 0, 'standard')
      const fast = m.calculateCost('seam-opus', 1_000, 100, 0, 0, 0, 'fast')
      expect(fast).toBeCloseTo(standard * 2, 12)
    }
  })

  it('a rehoster [0,0] stub cannot claim a name the vendor prices', async () => {
    // gemini-exp-1206's actual shape: the prefixed row is a `$0` stub and the
    // bare row is the real $0.30/M / $2.50/M card. Shadowed, a real model
    // priced to $0 and every call looked free.
    const m = await pricedBy({
      'gemini/seam-exp': { input_cost_per_token: 0, output_cost_per_token: 0 },
      'seam-exp': { input_cost_per_token: 3e-7, output_cost_per_token: 2.5e-6 },
    })
    const costs = costsOrThrow(m, 'seam-exp')
    expect(costs.inputCostPerToken).toBe(3e-7)
    expect(costs.outputCostPerToken).toBe(2.5e-6)
    expect(m.calculateCost('seam-exp', 1_000_000, 1_000_000, 0, 0, 0)).toBeGreaterThan(0)
  })

  it('the rehoster own prefixed key still resolves to ITS card', async () => {
    // The rule is about the bare alias, not about demoting rehosters: a session
    // that genuinely ran on the rehost must price at the rate it was charged.
    const m = await pricedBy(payload(true))
    expect(costsOrThrow(m, 'azure_ai/seam-opus').inputCostPerToken).toBe(9e-6)
  })

  it('the derived case-insensitive index inherits the same precedence', async () => {
    // The lowercase index is the engine's other derived index. A case-mismatched
    // query must not reach past the direct row to a rehoster's, which is what
    // happens if the index is built from the pre-precedence map.
    const m = await pricedBy(payload(true))
    expect(costsOrThrow(m, 'SEAM-OPUS').inputCostPerToken).toBe(5e-6)
  })
})

// ── 5. A $0 cache rate is a real rate, not a pricing gap ─────────────────────

describe('an honest $0 cache rate does not make a model look unpriced', () => {
  it('a free-to-cache model is not reported by findUnpricedModels', async () => {
    const m = await pricedBy({
      'seam-free-cache': {
        input_cost_per_token: 2.5e-6,
        output_cost_per_token: 1e-5,
        cache_read_input_token_cost: 1.25e-6,
      },
    })
    expect(costsOrThrow(m, 'seam-free-cache').cacheWriteCostPerToken).toBe(0)
    const unpriced = m.findUnpricedModels([{ model: 'seam-free-cache', calls: 12, cost: 0, tokens: 40_000 }])
    expect(unpriced).toEqual([])
  })

  it('a model that bills cache traffic alone is still recognised as priced', async () => {
    // The mirror of the rule above, in the direction the lowercase index's
    // predicate is indexed on: only a cache rate is positive, and that still
    // bills money, so it must not be filtered out as a zero-priced stub.
    const m = await pricedBy({
      'seam-cache-only': { input_cost_per_token: 0, output_cost_per_token: 0, cache_read_input_token_cost: 1e-7 },
    })
    const unpriced = m.findUnpricedModels([{ model: 'seam-cache-only', calls: 3, cost: 0, tokens: 9_000 }])
    expect(unpriced).toEqual([])
  })

  it('a genuine [0,0] stub with no billable rate is still reported as unpriced', async () => {
    // The other direction: an honest $0 cache rate must not become a licence to
    // treat every zero as priced. This is the signal that invites a quick-add.
    const m = await pricedBy({ 'seam-stub': { input_cost_per_token: 0, output_cost_per_token: 0 } })
    const unpriced = m.findUnpricedModels([{ model: 'seam-stub', calls: 5, cost: 0, tokens: 2_000 }])
    expect(unpriced.map(r => r.model)).toEqual(['seam-stub'])
  })

  it('an unknown model still prices to exactly 0', async () => {
    const m = await pricedBy({})
    expect(m.calculateCost('seam-never-heard-of-it', 1_000_000, 1_000_000, 0, 0, 0)).toBe(0)
    expect(m.getModelCosts('seam-never-heard-of-it')).toBeNull()
  })
})

// ── 6. The Models view agrees with billed spend ──────────────────────────────

describe('the Models view reports the output the scan billed', () => {
  // The fourth site that answered the reasoning question on its own. A
  // `codex` rollout's `output_tokens` already contains `reasoning_tokens`, so a
  // lens that adds them shows a row with more output than was billed AND
  // attributes cost to tokens the ledger never charged for.
  //
  // The fixture approach is `tests/models-view.test.ts`'s: a `LedgerStore` in a
  // temp dir, one `portIn` per call, then `buildModelsViewFromLedger`. No
  // network, no scan, no provider parser.
  const NOW = new Date(2026, 6, 15)
  const EMPTY_CONFIG: ModelsConfig = { aliases: [], overrides: [] }

  function storeWith(provider: string, output: number, reasoning: number, model: string): LedgerStore {
    const dir = mkdtempSync(join(tmpdir(), 'tr-price-seams-view-'))
    const store = new LedgerStore(join(dir, 'data.db'))
    const iso = new Date('2026-07-10T12:00:00').toISOString()
    const base = buildFixtureCachedCall(0)
    const call = {
      ...base,
      provider,
      model,
      usage: {
        ...base.usage,
        inputTokens: 1_000,
        outputTokens: output,
        reasoningTokens: reasoning,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        webSearchRequests: 0,
      },
      costUSD: 0,
      timestamp: iso,
    }
    const turn = buildFixtureCachedTurn(0, 'reasoning seam', {
      sessionId: 'sess-reasoning-seam',
      timestamp: iso,
      calls: [call],
    })
    store.portIn({
      provider,
      envFingerprint: 'env-demo',
      filePath: `/cache/${provider}/sess-reasoning-seam.jsonl`,
      verdict: 'new',
      cachedFile: buildFixtureCachedFile({ canonicalProjectName: 'demo-project', title: '', turns: [turn] }),
    })
    return store
  }

  // A codex call: the OpenAI subset contract, so the billed output is the
  // reported output alone.
  const CODEX = { provider: 'codex', output: 30, reasoning: 10, model: 'gpt-5' }
  // A gemini-shaped call: reasoning reported as a genuinely separate counter.
  const GEMINI = { provider: 'gemini', output: 100, reasoning: 40, model: 'gemini-3.1-pro-preview' }

  it('a codex by-model bucket reports the reported output, not output + reasoning', () => {
    const store = storeWith(CODEX.provider, CODEX.output, CODEX.reasoning, CODEX.model)
    const payload = buildModelsViewFromLedger(store, { period: 'lifetime' }, EMPTY_CONFIG, NOW)
    const row = payload.byModel[0]!
    // 30, not 40. `billableOutputTokens('codex', 30, 10)` is 30, and the scan
    // billed 30.
    expect(row.outputTokens).toBe(30)
    // The raw reasoning count is not lost — it is still in the audit row.
    expect(payload.audit[0]!.raw.reasoningTokens).toBe(10)
    store.close()
  })

  it('a codex by-task bucket reports the same count as its by-model sibling', () => {
    const store = storeWith(CODEX.provider, CODEX.output, CODEX.reasoning, CODEX.model)
    const payload = buildModelsViewFromLedger(store, { period: 'lifetime' }, EMPTY_CONFIG, NOW)
    expect(payload.byTask[0]!.outputTokens).toBe(payload.byModel[0]!.outputTokens)
    store.close()
  })

  it("a codex audit row's displayed output matches what the scan billed", () => {
    const store = storeWith(CODEX.provider, CODEX.output, CODEX.reasoning, CODEX.model)
    const payload = buildModelsViewFromLedger(store, { period: 'lifetime' }, EMPTY_CONFIG, NOW)
    const audit = payload.audit[0]!
    expect(audit.displayed.outputTokens).toBe(30)
    // And the cost block beneath it is computed from that same number, so the
    // two cannot disagree.
    const rates = audit.rates!
    expect(audit.cost.output).toBeCloseTo(30 * rates.outputCostPerToken, 12)
    // The sum the view reports is the sum the engine bills for that call.
    expect(audit.cost.recomputedTotalUSD).toBeCloseTo(calculateCost(CODEX.model, 1_000, 30, 0, 0, 0), 12)
    store.close()
  })

  it('a provider outside the set still gets the fold, in all three places', () => {
    const store = storeWith(GEMINI.provider, GEMINI.output, GEMINI.reasoning, GEMINI.model)
    const payload = buildModelsViewFromLedger(store, { period: 'lifetime' }, EMPTY_CONFIG, NOW)
    // gemini reports thoughts as a separate counter, so 100 + 40 = 140 is the
    // whole bill and dropping the 40 would under-report it.
    expect(payload.byModel[0]!.outputTokens).toBe(140)
    expect(payload.byTask[0]!.outputTokens).toBe(140)
    expect(payload.audit[0]!.displayed.outputTokens).toBe(140)
    store.close()
  })

  it('a codex row repriced through an Alias bills the same output the scan billed', () => {
    // The `resolveCallCost` path: with an Alias the lens re-prices the call
    // through `calculateCost` instead of trusting the scan's recorded cost, and
    // that re-price used to pass the RAW output through, so an aliased codex row
    // cost more than the identical call as recorded by a scan.
    const store = storeWith(CODEX.provider, CODEX.output, CODEX.reasoning, CODEX.model)
    const config: ModelsConfig = {
      aliases: [{ model: CODEX.model, aliasOf: 'gpt-5.1' }],
      overrides: [],
    }
    const payload = buildModelsViewFromLedger(store, { period: 'lifetime' }, config, NOW)
    const row = payload.byModel[0]!
    expect(row.model).toBe('gpt-5.1')
    expect(row.outputTokens).toBe(30)
    // 1000 in + 30 out at gpt-5.1's rates — 30 out, never 40.
    expect(row.costUSD).toBeCloseTo(calculateCost('gpt-5.1', 1_000, 30, 0, 0, 0), 12)
    expect(row.costUSD).not.toBeCloseTo(calculateCost('gpt-5.1', 1_000, 40, 0, 0, 0), 12)
    store.close()
  })

  it('a codex row repriced through a Price override uses the same output count', () => {
    const store = storeWith(CODEX.provider, CODEX.output, CODEX.reasoning, CODEX.model)
    const config: ModelsConfig = {
      aliases: [],
      overrides: [{ model: CODEX.model, inputPricePerMillion: 3, outputPricePerMillion: 15 }],
    }
    const payload = buildModelsViewFromLedger(store, { period: 'lifetime' }, config, NOW)
    const row = payload.byModel[0]!
    // 1000 @ $3/M + 30 @ $15/M.
    expect(row.costUSD).toBeCloseTo(0.003 + 30 * 15e-6, 12)
    expect(row.outputTokens).toBe(30)
    store.close()
  })
})

// ── 7. The Models audit lens knows the row was tiered ───────────────────────

describe('the Models audit lens does not badge a correctly-priced tiered row', () => {
  // The lens recomputes a row's cost as flat per-token rates × displayed tokens
  // and the renderer turns any residual against the attributed cost into an
  // "est" badge whose docstring says the only legitimate causes are fast mode
  // and the 1-hour cache rate. Holding FLAT rates while the engine billed the
  // tier made that badge fire on a row priced from a published rate card:
  // `xai/grok-4.6` at a 250,000-token prompt showed `attributedCostUSD` 1.000
  // against `recomputedTotalUSD` 0.500, and the app told the user its own
  // published number was an estimate.
  //
  // The rows are driven through the production RE-PRICE path (an Alias onto the
  // tiered model), so the attributed cost comes from `calculateCost` itself
  // rather than from a cost this test hand-wrote — the two numbers under
  // comparison are produced by two different functions, which is the whole
  // point of the seam.
  const NOW = new Date(2026, 6, 15)
  const XAI = 'xai/grok-4.6'
  const TIERED_PROMPT = 250_000
  // A re-hoster row in the fixture as well, so the lens has a second model it
  // can resolve without a tier.
  const PAYLOAD: Record<string, unknown> = {
    [XAI]: { input_cost_per_token: 2e-6, output_cost_per_token: 6e-6, cache_read_input_token_cost: 5e-7 },
  }

  interface RowOptions {
    rawModel: string
    aliasOf?: string
    inputTokens: number
    outputTokens?: number
    speed?: 'standard' | 'fast'
  }

  function auditRowFor(opts: RowOptions) {
    const dir = mkdtempSync(join(tmpdir(), 'tr-price-seams-audit-'))
    const store = new LedgerStore(join(dir, 'data.db'))
    const iso = new Date('2026-07-10T12:00:00').toISOString()
    const base = buildFixtureCachedCall(0)
    const call = {
      ...base,
      // `xai` is not in the output-inclusive set, so reasoning folds; it is 0
      // here so the row is about the tier and nothing else.
      provider: 'xai',
      model: opts.rawModel,
      usage: {
        ...base.usage,
        inputTokens: opts.inputTokens,
        outputTokens: opts.outputTokens ?? 0,
        reasoningTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        cachedInputTokens: 0,
        webSearchRequests: 0,
      },
      // The scan prices the call and records the result; the lens re-prices
      // through `resolveCallCost` because the Alias rewrote the model, so this
      // recorded value is not what the row is attributed.
      costUSD: 0,
      speed: opts.speed ?? 'standard',
      timestamp: iso,
    }
    const turn = buildFixtureCachedTurn(0, 'tier audit seam', {
      sessionId: 'sess-tier-audit',
      timestamp: iso,
      calls: [call],
    })
    store.portIn({
      provider: 'xai',
      envFingerprint: 'env-demo',
      filePath: '/cache/xai/sess-tier-audit.jsonl',
      verdict: 'new',
      cachedFile: buildFixtureCachedFile({ canonicalProjectName: 'demo-project', title: '', turns: [turn] }),
    })
    const config: ModelsConfig = {
      aliases: opts.aliasOf ? [{ model: opts.rawModel, aliasOf: opts.aliasOf }] : [],
      overrides: [],
    }
    const payload = buildModelsViewFromLedger(store, { period: 'lifetime' }, config, NOW)
    store.close()
    return payload.audit[0]!
  }

  it('a tiered row recomputes to the same total the engine billed', async () => {
    await pricedBy(PAYLOAD)
    const audit = auditRowFor({ rawModel: 'seam-grok-alias', aliasOf: XAI, inputTokens: TIERED_PROMPT })
    // The attributed cost is the TIERED one: 250,000 × $4/M = $1.00.
    expect(audit.attributedCostUSD).toBeCloseTo(1, 9)
    // The recompute lands on the same number because the lens resolved rates
    // through `getTieredModelCosts`, the same resolver `calculateCost` uses.
    expect(audit.cost.recomputedTotalUSD).toBeCloseTo(1, 9)
    // …and the badge does not fire. Before the fix: 0.5 against 1.0.
    expect(isAuditEstimated(audit)).toBe(false)
    // The rates the lens reported are the tier's, not the base card's.
    expect(audit.rates!.inputCostPerToken).toBe(4e-6)
  })

  it('a NON-tiered row still badges, on the cause the badge is for', async () => {
    // The control, and the reason the badge still exists: the scan billed a
    // fast-mode call at the row's `fastMultiplier` and a flat per-token
    // recompute cannot express that. A lens that suppressed the badge for
    // tiered rows must not have suppressed it for everything.
    //
    // The model is NOT the tiered one — a model with a tier rule would have its
    // recompute agree, which is the point of the other case. Sized so the
    // residual is dollars rather than fractions of a cent: the badge's
    // threshold is half a cent, so a token-count-sized example would pass the
    // threshold for the wrong reason.
    await pricedBy({
      ...PAYLOAD,
      'seam-fast-model': {
        input_cost_per_token: 1e-6,
        output_cost_per_token: 2e-6,
        provider_specific_entry: { fast: 4 },
      },
    })
    const audit = auditRowFor({
      rawModel: 'seam-fast-alias',
      aliasOf: 'seam-fast-model',
      inputTokens: 1_000_000,
      speed: 'fast',
    })
    // 1M × $1/M × 4 = $4.00 attributed, $1.00 recomputed.
    expect(audit.attributedCostUSD).toBeCloseTo(4, 9)
    expect(audit.cost.recomputedTotalUSD).toBeCloseTo(1, 9)
    expect(isAuditEstimated(audit)).toBe(true)
  })

  it('a re-hoster row keeps its own flat card and its own badge verdict', async () => {
    // The re-hoster is the B2 case seen from the display seam: a spelling with
    // no sourced long-context card stays flat, so the lens's flat recompute and
    // the engine's flat bill agree and no badge fires — the row is not
    // "estimated", it is exactly priced. `us.xai.grok-4.6` is the shape that
    // genuinely has no above-200k terms of its own.
    await pricedBy({
      ...PAYLOAD,
      'us.xai.grok-4.6': {
        input_cost_per_token: 2.2e-6,
        output_cost_per_token: 6.6e-6,
        cache_read_input_token_cost: 5.5e-7,
      },
    })
    const audit = auditRowFor({ rawModel: 'seam-grok-alias', aliasOf: 'us.xai.grok-4.6', inputTokens: TIERED_PROMPT })
    expect(audit.attributedCostUSD).toBeCloseTo(250_000 * 2.2e-6, 9)
    expect(audit.cost.recomputedTotalUSD).toBeCloseTo(250_000 * 2.2e-6, 9)
    expect(audit.rates!.inputCostPerToken).toBe(2.2e-6)
    expect(isAuditEstimated(audit)).toBe(false)
  })

  it('a tiered re-hoster row is badged for no second reason', async () => {
    // The B1 regression guard, for the re-hoster shape. `azure_ai/grok-4.6`
    // carries its own tier row, so the lens must reach the premium card through
    // the SAME resolver `calculateCost` uses. Before the seam existed the lens
    // recomputed at the flat rate, the residual tripped the "est" badge, and an
    // exactly-priced row was reported as an estimate.
    await pricedBy({
      ...PAYLOAD,
      'azure_ai/grok-4.6': {
        input_cost_per_token: 1.25e-6,
        output_cost_per_token: 6e-6,
        cache_read_input_token_cost: 5e-7,
      },
    })
    const audit = auditRowFor({ rawModel: 'seam-grok-alias', aliasOf: 'azure_ai/grok-4.6', inputTokens: TIERED_PROMPT })
    expect(audit.attributedCostUSD).toBeCloseTo(250_000 * 4e-6, 9)
    expect(audit.cost.recomputedTotalUSD).toBeCloseTo(250_000 * 4e-6, 9)
    expect(audit.rates!.inputCostPerToken).toBe(4e-6)
    expect(isAuditEstimated(audit)).toBe(false)
  })
})

// ── 8. Every override form a user's price can take beats a tier ─────────────
//
// MUST STAY LAST IN THIS FILE. These cases stub the bundled snapshot and
// re-import the engine module, and `vi.resetModules()` cannot be undone: every
// earlier case depends on `pricedBy` writing through the SAME module instance
// the statically-imported `calculateCost` and `buildModelsViewFromLedger` read
// from. A case added below this one would silently get the stubbed snapshot.
describe('a user price override beats a tier in every form getModelCosts honours', () => {
  // Why the snapshot is stubbed: the prefix and case-insensitive override
  // stages sit BELOW the catalog lookups, so for a model the catalog carries
  // `getModelCosts` never reaches them and the override is correctly ignored —
  // exactly as it is ignored without a tier. The stage that matters is the one
  // a model NO source prices reaches, which is the case the ADR sentence is
  // about ("would be silently repriced the moment a tier row is added for a
  // model the catalog does not carry"), and that is only constructible with an
  // empty catalog. The TIER RULE is in the module regardless of the catalog, so
  // `xai/grok-4.6` still has a rule with nothing behind it.
  const TIERED_PROMPT = 250_000
  const TIERED_TOTAL = 250_000 * 4e-6
  const OVERRIDE_TOTAL = 250_000 * 3e-6

  /** A fresh engine module whose bundled snapshot is empty, so the tier rule
   *  is reachable with no catalog row to answer first. */
  async function engineWithoutSnapshot(): Promise<typeof Models> {
    vi.resetModules()
    vi.doMock(SNAPSHOT_MODULE, () => ({ default: {} }))
    const fresh = await import('../src/main/pipeline/models.js')
    freshCacheDir()
    await Effect.runPromise(
      fresh
        .refreshPricingNowEffect()
        .pipe(
          Effect.provide(HttpFetch.layerWithFetch(fakeFetchOk({}))),
          Effect.provide(Env.layerWithValues({ vercelGatewayApiKey: null, pricingCacheTtlMs: Infinity })),
        ),
    )
    return fresh
  }

  afterEach(() => {
    vi.doUnmock(SNAPSHOT_MODULE)
  })

  it('control: with no catalog row and no override, the rule still prices nothing', async () => {
    const m = await engineWithoutSnapshot()
    expect(m.getModelCosts('xai/grok-4.6')).toBeNull()
    // A tier is a premium on a card, never a card: unknown stays exactly 0.
    expect(m.calculateCost('xai/grok-4.6', TIERED_PROMPT, 0, 0, 0, 0)).toBe(0)
  })

  it('the EXACT override form is honoured', async () => {
    const m = await engineWithoutSnapshot()
    m.setPriceOverrides({ 'xai/grok-4.6': { input: 3, output: 9 } })
    expect(m.calculateCost('xai/grok-4.6', TIERED_PROMPT, 0, 0, 0, 0)).toBeCloseTo(OVERRIDE_TOTAL, 12)
    expect(m.calculateCost('xai/grok-4.6', TIERED_PROMPT, 0, 0, 0, 0)).not.toBeCloseTo(TIERED_TOTAL, 12)
  })

  it('the PREFIX override form is honoured', async () => {
    // `grok` is a prefix of the rule's canonical name, so
    // `getPriceOverridePrefix` answers any `grok-…` id. That is a form the tier
    // used to ignore, because the tier re-asked the override tables for the
    // EXACT form only.
    const m = await engineWithoutSnapshot()
    m.setPriceOverrides({ grok: { input: 3, output: 9 } })
    // Prove it is the prefix lookup answering and not the exact one: a
    // different model the exact form could never match.
    expect(m.getModelCosts('grok-4.7')!.inputCostPerToken).toBe(3e-6)
    expect(m.calculateCost('xai/grok-4.6', TIERED_PROMPT, 0, 0, 0, 0)).toBeCloseTo(OVERRIDE_TOTAL, 12)
    expect(m.calculateCost('xai/grok-4.6', TIERED_PROMPT, 0, 0, 0, 0)).not.toBeCloseTo(TIERED_TOTAL, 12)
  })

  it('the CASE-INSENSITIVE override form is honoured', async () => {
    const m = await engineWithoutSnapshot()
    m.setPriceOverrides({ 'XAI/GROK-4.6': { input: 3, output: 9 } })
    expect(m.calculateCost('xai/grok-4.6', TIERED_PROMPT, 0, 0, 0, 0)).toBeCloseTo(OVERRIDE_TOTAL, 12)
    expect(m.calculateCost('xai/grok-4.6', TIERED_PROMPT, 0, 0, 0, 0)).not.toBeCloseTo(TIERED_TOTAL, 12)
  })

  it('with no override in any form, the tier still applies', async () => {
    // The other side of the contract: yielding to overrides must not have
    // switched the tier off.
    const m = await engineWithoutSnapshot()
    m.setPriceOverrides({ 'xai/other-model': { input: 3, output: 9 } })
    expect(m.calculateCost('xai/grok-4.6', TIERED_PROMPT, 0, 0, 0, 0)).toBe(0)
  })
})

// ── 9. The drift gate works on a Windows checkout ───────────────────────────
//
// Belongs beside `tests/litellm-snapshot-integrity.test.ts`; it lives here
// because the bundler and the engine share one contract and that file is out of
// this change's scope. The script is driven as a real child process against
// temp files, so nothing here depends on the network or on the committed
// bundle's contents.
describe('pricing:bundle --check survives a CRLF checkout', () => {
  const UPSTREAM: Record<string, unknown> = {
    sample_spec: { input_cost_per_token: 0, output_cost_per_token: 0 },
    'xai/seam-model': { input_cost_per_token: 2e-6, output_cost_per_token: 6e-6, cache_read_input_token_cost: 5e-7 },
    // A rehoster row, so the bundle has a stripped alias too and the fixture
    // exercises more than one line of the serializer.
    'azure_ai/seam-model': { input_cost_per_token: 1.25e-6, output_cost_per_token: 6e-6 },
  }

  function runBundler(args: string[]): number {
    try {
      execFileSync(process.execPath, [BUNDLER, ...args], { stdio: 'pipe' })
      return 0
    } catch (error) {
      return typeof (error as { status?: number }).status === 'number' ? (error as { status: number }).status : 1
    }
  }

  /** A generated bundle, plus the same bundle with CRLF endings — which is what
   *  a Windows clone with `core.autocrlf=true` and no `.gitattributes` hands
   *  the script. */
  function generateBundle(): { lf: string; crlf: string; dir: string } {
    const dir = mkdtempSync(join(tmpdir(), 'tr-bundle-check-'))
    const upstreamPath = join(dir, 'upstream.json')
    const lfPath = join(dir, 'bundle-lf.json')
    writeFileSync(upstreamPath, JSON.stringify(UPSTREAM), 'utf-8')
    expect(runBundler(['--input', upstreamPath, '--snapshot', lfPath])).toBe(0)
    const lf = readFileSync(lfPath, 'utf-8')
    return { lf, crlf: lf.replace(/\n/g, '\r\n'), dir }
  }

  it('passes against an LF bundle', () => {
    const { lf, crlf, dir } = generateBundle()
    const lfPath = join(dir, 'check-lf.json')
    const crlfPath = join(dir, 'check-crlf.json')
    writeFileSync(lfPath, lf, 'utf-8')
    writeFileSync(crlfPath, crlf, 'utf-8')
    expect(runBundler(['--check', '--input', join(dir, 'upstream.json'), '--snapshot', lfPath])).toBe(0)
  })

  it('passes against a CRLF bundle, which is what a Windows clone checks out', () => {
    // The regression: the comparison was `serialized === committed`, the
    // generator writes LF, and a CRLF checkout therefore reported drift on a
    // correct bundle — for every contributor on Windows, and only on Windows,
    // since CI checks out LF on ubuntu.
    const { crlf, dir } = generateBundle()
    const crlfPath = join(dir, 'check-crlf.json')
    writeFileSync(crlfPath, crlf, 'utf-8')
    expect(crlf).toContain('\r\n')
    expect(runBundler(['--check', '--input', join(dir, 'upstream.json'), '--snapshot', crlfPath])).toBe(0)
  })

  it('still fails on a real difference, so the normalization papers over nothing', () => {
    // The guard on the guard: a bundle whose CONTENT moved must still report
    // drift, whether its line endings are LF or CRLF.
    const { lf, crlf, dir } = generateBundle()
    const upstreamPath = join(dir, 'upstream.json')
    const moved = { ...UPSTREAM, 'xai/seam-model': { input_cost_per_token: 3e-6, output_cost_per_token: 6e-6 } }
    const movedUpstream = join(dir, 'upstream-moved.json')
    writeFileSync(movedUpstream, JSON.stringify(moved), 'utf-8')
    const lfPath = join(dir, 'moved-lf.json')
    const crlfPath = join(dir, 'moved-crlf.json')
    writeFileSync(lfPath, lf, 'utf-8')
    writeFileSync(crlfPath, crlf, 'utf-8')
    expect(runBundler(['--check', '--input', movedUpstream, '--snapshot', lfPath])).toBe(1)
    expect(runBundler(['--check', '--input', movedUpstream, '--snapshot', crlfPath])).toBe(1)
    // And the unchanged upstream against those same files still passes, so the
    // two failures above are about the rate and not about the fixture.
    expect(runBundler(['--check', '--input', upstreamPath, '--snapshot', crlfPath])).toBe(0)
  })
})
