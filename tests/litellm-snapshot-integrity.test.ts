// Offline guard for the bundled LiteLLM snapshot
// (`src/main/pipeline/data/litellm-snapshot.json`, ADR 0010).
//
// The file is a build artifact: `scripts/bundle-litellm.mjs` regenerates it
// from upstream. A 3000-line generated diff is exactly the kind of thing a
// reviewer skims, so this test polices the things a skim would miss — a
// malformed tuple, two rows that contradict each other, a model that quietly
// stopped resolving. It never touches the network: CI cannot rely on reaching
// raw.githubusercontent.com, and a test that fails when the network hiccups
// teaches people to ignore it. The drift check that DOES need the network is
// `npm run pricing:bundle -- --check`, run by
// `.github/workflows/pricing-drift.yml`.

import { describe, expect, it } from 'vitest'

import snapshotData from '../src/main/pipeline/data/litellm-snapshot.json'
import { getModelCosts } from '../src/main/pipeline/models.js'

// Mirrors the private `SnapshotEntry` in `src/main/pipeline/models.ts`, the type
// the engine casts this file to on load. Duplicated rather than imported: that
// type is not exported, and the guard should not depend on the code it polices.
type SnapshotEntry = [number, number, number | null, number | null, (number | null)?]

const entries = Object.entries(snapshotData as unknown as Record<string, SnapshotEntry>)
const byKey = new Map(entries)

function isRate(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isRateOrNull(value: unknown): boolean {
  return value === null || isRate(value)
}

function costsFor(model: string) {
  const costs = getModelCosts(model)
  if (costs === null) throw new Error(`${model} should resolve through the bundled snapshot`)
  return costs
}

describe('litellm snapshot integrity', () => {
  it('every entry is a 4/5-element tuple of usable USD-per-token rates', () => {
    const offenders: string[] = []
    for (const [key, entry] of entries) {
      if (!Array.isArray(entry) || (entry.length !== 4 && entry.length !== 5)) {
        offenders.push(`${key}: expected an array of 4 or 5 elements, got ${JSON.stringify(entry)}`)
        continue
      }
      const [input, output, cacheWrite, cacheRead, fast] = entry
      if (!isRate(input)) offenders.push(`${key}: input rate ${JSON.stringify(input)} is not a finite number >= 0`)
      if (!isRate(output)) offenders.push(`${key}: output rate ${JSON.stringify(output)} is not a finite number >= 0`)
      if (!isRateOrNull(cacheWrite)) {
        offenders.push(`${key}: cache-write rate ${JSON.stringify(cacheWrite)} is not null or a finite number >= 0`)
      }
      if (!isRateOrNull(cacheRead)) {
        offenders.push(`${key}: cache-read rate ${JSON.stringify(cacheRead)} is not null or a finite number >= 0`)
      }
      if (fast !== undefined && fast !== null && !(typeof fast === 'number' && Number.isFinite(fast) && fast >= 1)) {
        offenders.push(`${key}: fast multiplier ${JSON.stringify(fast)} is not null or a finite number >= 1`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('never lets a date-pinned row contradict its bare sibling on input or output', () => {
    // `X` and `X@20241022` are the same model, so their [input, output] must
    // match. They did not once: the hand-maintained bundle carried a bare
    // `claude-3-5-haiku` at one price and a pinned sibling at another, and a
    // lookup that hit the wrong one billed real calls at the wrong rate.
    //
    // Scoped to DATED pins on purpose. A pin that is a release selector rather
    // than a date (`mistral-large@2407`, `mistral-nemo@2407`,
    // `mistral-medium-3@001`, `mistral-large@latest`) names a DIFFERENT release
    // of the family than the bare key, and upstream prices those differently on
    // purpose — `mistral-large` is $4/$12 while `mistral-large@2407` is $2/$6.
    // Demanding they agree would be demanding a lie, so they are not compared.
    //
    // Scoped to INPUT AND OUTPUT only, also on purpose. Cache rates are
    // deliberately excluded because a dated release can legitimately predate
    // prompt caching, and then null is the correct rate rather than a
    // contradiction: `claude-3-5-sonnet@20240620` predates caching and carries
    // no cache rates, while the bare `claude-3-5-sonnet` row tracks a later
    // revision that has them. Comparing cache rates would flag that as a
    // violation when it is a fact about release history.
    const offenders: string[] = []
    let compared = 0
    for (const [key, entry] of entries) {
      const at = key.indexOf('@')
      if (at < 0) continue
      if (!/^\d{8}$/.test(key.slice(at + 1))) continue
      const bare = byKey.get(key.slice(0, at))
      if (!bare) continue
      compared += 1
      if (bare[0] !== entry[0] || bare[1] !== entry[1]) {
        offenders.push(
          `${key.slice(0, at)} ${JSON.stringify([bare[0], bare[1]])} vs ${key} ${JSON.stringify([entry[0], entry[1]])}`,
        )
      }
    }
    // Guards the guard: if upstream ever renames away every date-pinned row the
    // rule above would pass by comparing nothing.
    expect(compared).toBeGreaterThan(0)
    expect(offenders).toEqual([])
  })

  it('prices the rows the drift report called out at their upstream rates', () => {
    // Every expectation below cites the upstream value in
    // model_prices_and_context_window.json, so a future regeneration that moves
    // a price fails here instead of silently re-billing.

    // `claude-opus-4-6`: upstream input_cost_per_token 5e-6,
    // output_cost_per_token 25e-6, and NO provider_specific_entry.fast. The
    // hand-maintained bundle carried a 6 in the fast slot, overcharging every
    // fast-mode Opus 4.6 call sixfold.
    const opus46 = costsFor('claude-opus-4-6')
    expect(opus46.inputCostPerToken).toBe(5e-6)
    expect(opus46.outputCostPerToken).toBe(25e-6)
    expect(opus46.cacheWriteCostPerToken).toBe(6.25e-6)
    expect(opus46.cacheReadCostPerToken).toBe(5e-7)
    expect(opus46.fastMultiplier).toBe(1)

    // `claude-opus-4-7`: upstream 5e-6 / 25e-6, same missing `fast` field.
    const opus47 = costsFor('claude-opus-4-7')
    expect(opus47.inputCostPerToken).toBe(5e-6)
    expect(opus47.outputCostPerToken).toBe(25e-6)
    expect(opus47.fastMultiplier).toBe(1)

    // `claude-fable-5-1`: upstream 1e-5 / 5e-5, cache_read_input_token_cost
    // 2.5e-7. The row was missing entirely, so lookups prefix-matched the older
    // `claude-fable-5` and read its 1e-6 cache-read rate — 4x too high.
    const fable51 = costsFor('claude-fable-5-1')
    expect(fable51.inputCostPerToken).toBe(1e-5)
    expect(fable51.outputCostPerToken).toBe(5e-5)
    expect(fable51.cacheReadCostPerToken).toBe(2.5e-7)

    // Region rows track upstream too: `eu.anthropic.claude-opus-4-6-v1` is
    // priced 10% above the global row in upstream, and the bundle used to carry
    // a global-shaped rate for it.
    const euOpus46 = costsFor('eu.anthropic.claude-opus-4-6-v1')
    expect(euOpus46.inputCostPerToken).toBe(5.5e-6)
    expect(euOpus46.outputCostPerToken).toBe(27.5e-6)
  })

  it('prices a sample of everyday ids at their upstream rates', () => {
    // gpt-4o: upstream 2.5e-6 / 1e-5 with a cache_read_input_token_cost of
    // 1.25e-6 and NO cache-write rate. The `null` in the bundle's third slot is
    // the VENDOR omitting the rate (OpenAI-family caching has no write premium),
    // so the engine reads it as the $0 the vendor charges rather than deriving
    // input x 1.25 = 3.125e-6 (ADR 0010: never invent a plausible-looking rate
    // for a model; a wrong `$X` hides real spend). `tests/price-engine-seams.test.ts`
    // pins the no-fabrication rule on both input paths.
    const gpt4o = costsFor('gpt-4o')
    expect(gpt4o.inputCostPerToken).toBe(2.5e-6)
    expect(gpt4o.outputCostPerToken).toBe(1e-5)
    expect(gpt4o.cacheWriteCostPerToken).toBe(0)
    expect(gpt4o.cacheReadCostPerToken).toBe(1.25e-6)

    // o3: upstream 2e-6 / 8e-6, cache_read_input_token_cost 5e-7.
    const o3 = costsFor('o3')
    expect(o3.inputCostPerToken).toBe(2e-6)
    expect(o3.outputCostPerToken).toBe(8e-6)
    expect(o3.cacheReadCostPerToken).toBe(5e-7)

    // claude-sonnet-4-6: upstream 3e-6 / 1.5e-5 with both cache rates.
    const sonnet46 = costsFor('claude-sonnet-4-6')
    expect(sonnet46.inputCostPerToken).toBe(3e-6)
    expect(sonnet46.outputCostPerToken).toBe(1.5e-5)
    expect(sonnet46.cacheReadCostPerToken).toBe(3e-7)
  })
})
