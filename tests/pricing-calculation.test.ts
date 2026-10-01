import { afterEach, describe, expect, it, vi } from 'vitest'

import { takeQueuedLogRecords } from '../src/main/pipeline/file-errors.js'
import {
  calculateRepricedCost,
  captureModelPricingCatalogue,
  createPricingConfigLookup,
  setModelAliases,
  setPriceOverrides,
} from '../src/main/pipeline/models.js'

import {
  calculateCost,
  calculateRepricedCostResult,
  capturePricingCatalogue,
  getModelCosts,
  getTieredModelCosts,
  type ModelCosts,
} from '../src/main/pipeline/pricing-calculation.js'

afterEach(() => {
  takeQueuedLogRecords()
  vi.unstubAllEnvs()
})

const costs = (input: number, output = 0, cacheRead = 0): ModelCosts => ({
  inputCostPerToken: input,
  outputCostPerToken: output,
  cacheWriteCostPerToken: 0,
  cacheReadCostPerToken: cacheRead,
  webSearchCostPerRequest: 0.01,
  fastMultiplier: 1,
})

const capture = (
  prices: Map<string, ModelCosts>,
  overrides = new Map<string, ModelCosts>(),
  userAliases: Record<string, string> = {},
) =>
  capturePricingCatalogue({
    prices,
    overrides,
    builtinAliases: { 'old-model': 'vendor/model' },
    userAliases,
    tiers: [
      {
        model: 'vendor/model',
        tiers: [{ promptTokensAtLeast: 200_000, rates: { inputCostPerToken: 4e-6, outputCostPerToken: 12e-6 } }],
      },
    ],
    routedSegments: new Set(['router', 'vendor']),
  })

describe('explicit pricing catalogue calculation', () => {
  it('isolates a captured catalogue from later source map and card changes', () => {
    const card = costs(2e-6, 6e-6)
    const livePrices = new Map([['vendor/model', card]])
    const aliases = { 'user-model': 'vendor/model' }
    const snapshot = capture(livePrices, new Map(), aliases)

    card.inputCostPerToken = 99
    livePrices.set('vendor/model', costs(20))
    livePrices.set('new-model', costs(1))
    aliases['user-model'] = 'new-model'

    expect(getModelCosts(snapshot, 'vendor/model')?.inputCostPerToken).toBe(2e-6)
    expect(getModelCosts(snapshot, 'user-model')?.inputCostPerToken).toBe(2e-6)
    expect(getModelCosts(snapshot, 'new-model')).toBeNull()
  })

  it('keeps existing request captures stable across live alias and override updates', () => {
    setModelAliases({})
    setPriceOverrides({})
    const before = captureModelPricingCatalogue()
    const originalRate = getModelCosts(before, 'claude-sonnet-4-6')?.inputCostPerToken

    try {
      setModelAliases({ 'request-alias': 'claude-sonnet-4-6' })
      setPriceOverrides({ 'claude-sonnet-4-6': { input: 77, output: 99 } })
      const after = captureModelPricingCatalogue()

      expect(after).not.toBe(before)
      expect(getModelCosts(before, 'request-alias')).toBeNull()
      expect(getModelCosts(before, 'claude-sonnet-4-6')?.inputCostPerToken).toBe(originalRate)
      expect(getModelCosts(after, 'request-alias')?.inputCostPerToken).toBe(77e-6)
    } finally {
      setModelAliases({})
      setPriceOverrides({})
    }
  })

  it('keeps alias, routed-id and inclusive tier behavior in the pure resolver', () => {
    const snapshot = capture(new Map([['vendor/model', costs(2e-6, 6e-6)]]))

    expect(getModelCosts(snapshot, 'old-model')?.inputCostPerToken).toBe(2e-6)
    expect(getModelCosts(snapshot, 'router/vendor/model')?.outputCostPerToken).toBe(6e-6)
    expect(getTieredModelCosts(snapshot, 'vendor/model', 199_999)?.inputCostPerToken).toBe(2e-6)
    expect(getTieredModelCosts(snapshot, 'vendor/model', 200_000)?.inputCostPerToken).toBe(4e-6)
  })

  it('ignores inherited alias names while honoring an explicit own alias', () => {
    const prices = new Map([['vendor/model', costs(2e-6, 6e-6)]])
    const unconfigured = capture(prices)
    const configured = capture(prices, new Map(), { constructor: 'vendor/model' })

    expect(getModelCosts(unconfigured, 'constructor')).toBeNull()
    expect(getModelCosts(unconfigured, 'toString')).toBeNull()
    expect(getModelCosts(unconfigured, '__proto__')).toBeNull()
    expect(getModelCosts(configured, 'constructor')?.inputCostPerToken).toBe(2e-6)
  })

  it('prices cache-write tokens as part of the context prompt and applies fast mode once', () => {
    const snapshot = capture(new Map([['vendor/model', { ...costs(2e-6, 6e-6), fastMultiplier: 2 }]]))

    expect(calculateCost(snapshot, 'vendor/model', 190_000, 0, 10_000, 0, 0)).toBeCloseTo(0.76, 9)
    expect(calculateCost(snapshot, 'vendor/model', 190_000, 0, 10_000, 0, 0, 'fast')).toBeCloseTo(1.52, 9)
  })

  it('lets an exact user override win over a tier', () => {
    const snapshot = capture(
      new Map([['vendor/model', costs(2e-6, 6e-6)]]),
      new Map([['vendor/model', costs(1e-6, 1e-6)]]),
    )

    expect(getTieredModelCosts(snapshot, 'vendor/model', 300_000)?.inputCostPerToken).toBe(1e-6)
    expect(calculateCost(snapshot, 'vendor/model', 300_000, 1_000_000, 0, 0, 0)).toBeCloseTo(1.3, 9)
  })

  it('leaves unknown models unpriced and does not invent a cache rate', () => {
    const snapshot = capture(new Map([['vendor/model', costs(2e-6, 6e-6)]]))

    expect(getModelCosts(snapshot, 'not-listed')).toBeNull()
    expect(calculateCost(snapshot, 'not-listed', 1_000_000, 0, 0, 0, 0)).toBe(0)
    expect(getModelCosts(snapshot, 'vendor/model')?.cacheWriteCostPerToken).toBe(0)
  })

  it('logs one sanitized warning when an Alias target is unknown during query repricing', () => {
    vi.stubEnv('WATCHTOWER_VERBOSE', '1')
    const rawModel = 'raw-warning-source'
    const effectiveModel = 'missing\nrate-card'
    const pricingConfig = createPricingConfigLookup([{ model: rawModel, aliasOf: effectiveModel }], [])
    const snapshot = capture(new Map([['known-model', costs(2e-6)]]))
    const call = {
      model: rawModel,
      effectiveModel,
      inputTokens: 100,
      outputTokens: 10,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      speed: 'standard' as const,
      recordedCost: 0,
    }

    expect(calculateRepricedCostResult(snapshot, pricingConfig, call)).toEqual({ cost: 0, priced: false })
    expect(takeQueuedLogRecords()).toEqual([])
    expect(calculateRepricedCost(snapshot, pricingConfig, call)).toBe(0)
    expect(calculateRepricedCost(snapshot, pricingConfig, call)).toBe(0)
    expect(takeQueuedLogRecords()).toEqual([
      {
        logEvent: 'pricing.unpriced',
        level: 'warn',
        fields: { op: 'pricing', model: 'missing?rate-card', code: 'unpriced' },
      },
    ])
  })

  it('does not diagnose an unknown model when an override or recorded cost answers', () => {
    vi.stubEnv('WATCHTOWER_VERBOSE', '1')
    const snapshot = capture(new Map([['known-model', costs(2e-6)]]))
    const unknown = 'unknown-with-user-price'
    const overrideConfig = createPricingConfigLookup(
      [],
      [
        {
          model: unknown,
          inputPricePerMillion: 5,
          outputPricePerMillion: 9,
        },
      ],
    )
    const baseCall = {
      model: 'raw-override-source',
      effectiveModel: unknown,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
      speed: 'standard' as const,
      recordedCost: 42,
    }

    expect(calculateRepricedCost(snapshot, overrideConfig, baseCall)).toBe(14)
    expect(
      calculateRepricedCost(snapshot, createPricingConfigLookup([], []), {
        ...baseCall,
        model: unknown,
        effectiveModel: unknown,
      }),
    ).toBe(42)
    expect(takeQueuedLogRecords()).toEqual([])
  })
})
