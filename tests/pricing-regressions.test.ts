import { describe, expect, it } from 'vitest'

import { billableOutputTokens } from '../src/main/pipeline/billable-output.js'
import { calculateCost, getModelCosts } from '../src/main/pipeline/models.js'

/**
 * Regression guards for the pricing-correctness work recorded in ADR 0033.
 *
 * Each case pins a specific number that was wrong before, by the amount it was
 * wrong by, so a future regeneration or refactor that reintroduces one fails
 * here rather than silently shipping a price.
 */
describe('pricing regressions (ADR 0033)', () => {
  it('prices a fast-mode call at the published multiplier, not a stale one', () => {
    // The bundled catalog carried a fast-mode multiplier of 6 for these two
    // rows while the vendor publishes none, next to their own `@default`
    // siblings carrying null. Every fast-mode call billed 6x.
    for (const model of ['claude-opus-4-6', 'claude-opus-4-7']) {
      expect(getModelCosts(model)?.fastMultiplier).toBe(1)
      expect(calculateCost(model, 0, 1_000_000, 0, 0, 0, 'fast')).toBeCloseTo(25, 6)
      expect(calculateCost(model, 0, 1_000_000, 0, 0, 0, 'standard')).toBeCloseTo(25, 6)
    }
    // A model the vendor DOES price a premium for still gets it.
    expect(getModelCosts('claude-opus-5')?.fastMultiplier).toBe(2)
    expect(calculateCost('claude-opus-5', 0, 1_000_000, 0, 0, 0, 'fast')).toBeCloseTo(50, 6)
  })

  it('reads a cache rate the vendor publishes instead of a sibling’s', () => {
    // `claude-fable-5-1` was absent from the catalog, so the lookup fell
    // through the prefix match onto `claude-fable-5` and read its cache-read
    // rate. This model is the one Claude family that discounts cache reads to
    // 2.5% of input rather than 10%, so the miss billed cache reads 4x high.
    const fable = getModelCosts('claude-fable-5-1')!
    expect(fable.inputCostPerToken).toBeCloseTo(10e-6, 12)
    expect(fable.cacheReadCostPerToken).toBeCloseTo(0.25e-6, 12)
    // Its predecessor keeps the 10% rate, so the two must not be conflated.
    expect(getModelCosts('claude-fable-5')!.cacheReadCostPerToken).toBeCloseTo(1e-6, 12)
  })

  it('bills reasoning once for a provider that reports it inside output', () => {
    // The parser added reasoningTokens to outputTokens for every provider
    // except claude. OpenAI reports reasoning_tokens as a subset of
    // output_tokens, so codex and copilot were billed for the same tokens
    // twice. A provider that reports them disjointly still gets the sum.
    expect(billableOutputTokens('claude', 30, 10)).toBe(30)
    expect(billableOutputTokens('codex', 30, 10)).toBe(30)
    expect(billableOutputTokens('copilot', 30, 10)).toBe(30)
    expect(billableOutputTokens('gemini', 30, 10)).toBe(40)
    expect(billableOutputTokens('qwen', 30, 10)).toBe(40)
  })

  it('reads an omitted cache-write rate as free, not as a premium', () => {
    // The 1.25x of input is Anthropic's 5-minute cache-write ratio, and it was
    // being applied to every vendor whose feed omits the field. OpenAI charges
    // no cache-write premium, so this invented one on top of a real input cost.
    const gpt4o = getModelCosts('gpt-4o')!
    expect(gpt4o.cacheWriteCostPerToken).toBe(0)
    // The cache-read rate the vendor does publish is still read literally.
    expect(gpt4o.cacheReadCostPerToken).toBeCloseTo(1.25e-6, 12)
    // Anthropic, which publishes both, is unaffected.
    expect(getModelCosts('claude-sonnet-4-6')!.cacheWriteCostPerToken).toBeCloseTo(3.75e-6, 12)
  })

  it('prices a first-party model id at the first-party rate, not a re-hoster’s', () => {
    // Upstream holds no `claude-3-5-haiku` key; the bare name exists in the
    // bundle only because `vertex_ai/claude-3-5-haiku` strips onto it at $1.00 /
    // $5.00. Every first-party spelling in the catalog says $0.80 / $4.00, so a
    // session recorded against the direct API was billed 25% high.
    const bare = getModelCosts('claude-3-5-haiku')!
    const firstParty = getModelCosts('anthropic.claude-3-5-haiku-20241022-v1:0')!
    expect(bare.inputCostPerToken).toBe(firstParty.inputCostPerToken)
    expect(bare.outputCostPerToken).toBe(firstParty.outputCostPerToken)
    // A re-hoster still resolves to its own published card.
    expect(getModelCosts('vertex_ai/claude-3-5-haiku')!.inputCostPerToken).toBeCloseTo(1e-6, 12)
  })

  it('keeps retired models that the built-in aliases point at priced', () => {
    // The regeneration dropped 346 rows the vendor had retired. Most are
    // correctly gone and now show as unpriced, but a retired Claude generation
    // had begun resolving to a re-hoster's same-named model at a third of the
    // real price, and the Kimi K2 family that `kimi-auto` aliases onto had gone
    // unpriced entirely.
    const opus4 = getModelCosts('claude-4-opus')!
    expect(opus4.inputCostPerToken).toBeCloseTo(15e-6, 12)
    expect(opus4.outputCostPerToken).toBeCloseTo(75e-6, 12)
    expect(getModelCosts('kimi-auto')!.inputCostPerToken).toBeCloseTo(0.6e-6, 12)
    expect(getModelCosts('kimi-k2-thinking')!.outputCostPerToken).toBeCloseTo(2.5e-6, 12)
  })

  it('reproduces a known-good bill exactly, cache tiers included', () => {
    // The arithmetic itself was never wrong and this pins it, so a change to
    // calculateCost that shifts a cent shows up here rather than in a user's
    // total. 1,534 input, 665,208 output, 1,607,100 cache-write of which
    // 1,324,414 are one-hour entries, 150,648,563 cache-read, on claude-sonnet-5
    // at $2/M in, $10/M out, $2.50/M five-minute write, $0.20/M read. The
    // one-hour entries bill at 1.6x the five-minute rate, which is 2x input.
    const tokens = {
      model: 'claude-sonnet-5',
      input: 1534,
      output: 665208,
      cacheWrite: 1_607_100,
      oneHourWrite: 1_324_414,
      cacheRead: 150_648_563,
    }
    expect(
      calculateCost(tokens.model, tokens.input, tokens.output, tokens.cacheWrite, tokens.cacheRead, 0, 'standard', 0),
    ).toBeCloseTo(40.8026106, 7)
    expect(
      calculateCost(
        tokens.model,
        tokens.input,
        tokens.output,
        tokens.cacheWrite,
        tokens.cacheRead,
        0,
        'standard',
        tokens.oneHourWrite,
      ),
    ).toBeCloseTo(42.7892316, 7)
  })
})
