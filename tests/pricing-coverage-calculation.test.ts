import { afterEach, describe, expect, it } from 'vitest'

import {
  captureLocalModelSavings,
  captureModelPricingCatalogue,
  findUnpricedModels as findUnpricedModelsLive,
  isExpectedFreeModel as isExpectedFreeModelLive,
  setLocalModelSavings,
  setModelAliases,
  setPriceOverrides,
} from '../src/main/pipeline/models.js'
import {
  capturePricingCatalogue,
  findUnpricedModels,
  getLocalSavingsBaseline,
  isExpectedFreeModel,
  type ModelCosts,
} from '../src/main/pipeline/pricing-calculation.js'

afterEach(() => {
  setLocalModelSavings({})
  setModelAliases({})
  setPriceOverrides({})
})

const rates = (input: number, output = 0, cacheWrite = 0, cacheRead = 0): ModelCosts => ({
  inputCostPerToken: input,
  outputCostPerToken: output,
  cacheWriteCostPerToken: cacheWrite,
  cacheReadCostPerToken: cacheRead,
  webSearchCostPerRequest: 0,
  fastMultiplier: 1,
})

function fixture(overrides = new Map<string, ModelCosts>()) {
  return capturePricingCatalogue({
    prices: new Map([
      ['vendor/free-stub', rates(0)],
      ['vendor/cache-only', rates(0, 0, 0, 3e-6)],
      ['prefix-stub-model', rates(0)],
      ['paid-model', rates(2e-6, 8e-6)],
    ]),
    overrides,
    builtinAliases: {},
    userAliases: { 'free-alias': 'vendor/free-stub' },
    tiers: [],
    routedSegments: new Set(),
  })
}

describe('explicit pricing coverage calculation', () => {
  it('uses independent expected results for exclusions, zero stubs, and positive cache-only cards', () => {
    const catalogue = fixture()
    const localSavings = { 'mapped-local-model': 'paid-model' }
    const rows = [
      { model: 'vendor/free-stub', calls: 1, cost: 0, tokens: 100 },
      { model: 'free-alias', calls: 2, cost: 0, tokens: 200 },
      { model: 'prefix-stub-model', calls: 1, cost: 0, tokens: 300 },
      { model: 'vendor/cache-only', calls: 1, cost: 0, tokens: 400 },
      { model: 'paid-model', calls: 1, cost: 0, tokens: 500 },
      { model: 'mapped-local-model', calls: 1, cost: 0, tokens: 600 },
      { model: 'local:quantized', calls: 1, cost: 0, tokens: 700 },
      { model: 'Opus 4.8', calls: 1, cost: 0, tokens: 800 },
      { model: 'already-costed', calls: 1, cost: 0.01, tokens: 900 },
    ]

    expect(findUnpricedModels(catalogue, localSavings, rows)).toEqual([
      { model: 'Opus 4.8', calls: 1, tokens: 800 },
      { model: 'prefix-stub-model', calls: 1, tokens: 300 },
      { model: 'free-alias', calls: 2, tokens: 200 },
      { model: 'vendor/free-stub', calls: 1, tokens: 100 },
    ])
    expect(isExpectedFreeModel(catalogue, localSavings, 'local:quantized')).toBe(true)
    expect(isExpectedFreeModel(catalogue, localSavings, 'mapped-local-model')).toBe(true)
    expect(isExpectedFreeModel(catalogue, localSavings, 'vendor/cache-only')).toBe(false)
  })

  it('counts only an exact zero override as an explicit free declaration', () => {
    const catalogue = fixture(
      new Map([
        ['prefix-stub', rates(0)],
        ['explicit-free', rates(0)],
      ]),
    )
    const rows = [
      { model: 'vendor/free-stub', calls: 1, cost: 0, tokens: 20 },
      { model: 'prefix-stub-model', calls: 1, cost: 0, tokens: 30 },
      { model: 'explicit-free', calls: 1, cost: 0, tokens: 40 },
    ]

    expect(findUnpricedModels(catalogue, {}, rows)).toEqual([
      { model: 'prefix-stub-model', calls: 1, tokens: 30 },
      { model: 'vendor/free-stub', calls: 1, tokens: 20 },
    ])
    expect(isExpectedFreeModel(catalogue, {}, 'explicit-free')).toBe(true)
    const aliasedExactFree = fixture(new Map([['vendor/free-stub', rates(0)]]))
    expect(isExpectedFreeModel(aliasedExactFree, {}, 'free-alias')).toBe(true)
  })

  it('keeps local mappings as captured raw-key data with no live callback', () => {
    setLocalModelSavings({ 'raw/provider-model': 'paid-model' })
    const captured = captureLocalModelSavings()
    setLocalModelSavings({ 'raw/provider-model': 'different-baseline' })

    expect(getLocalSavingsBaseline(captured, 'raw/provider-model')).toBe('paid-model')
    expect(getLocalSavingsBaseline(captured, 'provider-model')).toBeUndefined()
    expect(getLocalSavingsBaseline(captured, 42 as unknown as string)).toBeUndefined()
    expect(Object.isFrozen(captured)).toBe(true)
  })

  it('keeps compatibility adapters in parity with one captured pricing and savings input', () => {
    setModelAliases({ 'coverage-alias': 'coverage-missing-target' })
    setPriceOverrides({ 'coverage-exact-free': { input: 0, output: 0 } })
    setLocalModelSavings({ 'coverage-local-raw': 'paid-model' })

    const catalogue = captureModelPricingCatalogue()
    const localSavings = captureLocalModelSavings()
    const rows = [
      { model: 'coverage-alias', calls: 1, cost: 0, tokens: 300 },
      { model: 'coverage-exact-free', calls: 1, cost: 0, tokens: 250 },
      { model: 'coverage-local-raw', calls: 1, cost: 0, tokens: 200 },
      { model: 'Opus 4.8', calls: 1, cost: 0, tokens: 100 },
    ]

    expect(findUnpricedModelsLive(rows)).toEqual(findUnpricedModels(catalogue, localSavings, rows))
    expect(isExpectedFreeModelLive('coverage-exact-free')).toBe(
      isExpectedFreeModel(catalogue, localSavings, 'coverage-exact-free'),
    )
    expect(isExpectedFreeModelLive('coverage-local-raw')).toBe(
      isExpectedFreeModel(catalogue, localSavings, 'coverage-local-raw'),
    )
    expect(findUnpricedModelsLive(rows)).toEqual([
      { model: 'coverage-alias', calls: 1, tokens: 300 },
      { model: 'Opus 4.8', calls: 1, tokens: 100 },
    ])
  })
})
