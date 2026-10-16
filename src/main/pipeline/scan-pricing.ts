import {
  calculateCostResult,
  getLocalSavingsBaseline,
  getModelCosts,
  type LocalModelSavings,
  type PricingCatalogue,
} from './pricing-calculation.js'

export type ScanCostCalculation = (
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  webSearchRequests: number,
  speed?: 'standard' | 'fast',
  oneHourCacheCreationTokens?: number,
) => number

/** Pricing inputs owned by one scan. Calculations never recapture live state. */
export interface ScanPricing {
  readonly calculateCost: ScanCostCalculation
  readonly calculateLocalModelSavings: (...usage: Parameters<ScanCostCalculation>) => {
    savingsUSD: number
    baselineModel: string
  } | null
}

export function createScanPricing(
  catalogue: PricingCatalogue,
  localSavings: LocalModelSavings,
  reportUnknownModel: (model: string) => void,
): ScanPricing {
  const calculateCost: ScanCostCalculation = (model, ...usage) => {
    const result = calculateCostResult(catalogue, model, ...usage)
    if (!result.priced) reportUnknownModel(model)
    return result.cost
  }
  return {
    calculateCost,
    calculateLocalModelSavings: (model, ...usage) => {
      const baselineModel = getLocalSavingsBaseline(localSavings, model)
      if (!baselineModel || !getModelCosts(catalogue, baselineModel)) return null
      return { savingsUSD: calculateCost(baselineModel, ...usage), baselineModel }
    },
  }
}
