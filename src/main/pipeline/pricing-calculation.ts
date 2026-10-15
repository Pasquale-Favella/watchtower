/** Pure pricing resolution and arithmetic. The caller captures the catalogue
 * once and passes it to calculations; this module never reads application
 * state, performs IO, or logs. */
import type { ModelCosts as SharedModelCosts, PriceOverride } from '../../shared/schemas/models.js'

export type ModelCosts = SharedModelCosts

export type ConfigRatePair = Pick<PriceOverride, 'inputPricePerMillion' | 'outputPricePerMillion'>

export type PricingConfigLookup = {
  resolveAlias(model: string): string
  findOverride(name: string): ConfigRatePair | undefined
}

export function stripPinAndDate(model: string): string {
  return model.replace(/@.*$/, '').replace(/-\d{8}$/, '')
}

/** Normalize an explicit alias/override name without reading live config. */
export function normalizeModelKey(model: string): string {
  const variantStripped = model.replace(/:(thinking|cloud)$/i, '').replace(/-TEE$/i, '')
  return stripPinAndDate(variantStripped)
    .replace(/^([^/]+\/)+/, '')
    .toLowerCase()
}

/** Build the request's immutable alias and override lookup from captured rows. */
export function createPricingConfigLookup(
  aliases: ReadonlyArray<{ model: string; aliasOf: string }>,
  overrides: ReadonlyArray<{ model: string; inputPricePerMillion: number; outputPricePerMillion: number }>,
): PricingConfigLookup {
  const aliasExact = new Map<string, string>()
  const aliasNormalized = new Map<string, string>()
  for (const alias of aliases) {
    aliasExact.set(alias.model, alias.aliasOf)
    aliasNormalized.set(normalizeModelKey(alias.model), alias.aliasOf)
  }

  const overrideExact = new Map<string, ConfigRatePair>()
  const overrideNormalized = new Map<string, ConfigRatePair>()
  for (const override of overrides) {
    const rates = {
      inputPricePerMillion: override.inputPricePerMillion,
      outputPricePerMillion: override.outputPricePerMillion,
    }
    overrideExact.set(override.model, rates)
    overrideNormalized.set(normalizeModelKey(override.model), rates)
  }

  return {
    resolveAlias(model: string): string {
      return aliasExact.get(model) ?? aliasNormalized.get(normalizeModelKey(model)) ?? model
    },
    findOverride(model: string): ConfigRatePair | undefined {
      return overrideExact.get(model) ?? overrideNormalized.get(normalizeModelKey(model))
    },
  }
}

export type PricingTier = {
  model: string
  tiers: readonly {
    promptTokensAtLeast: number
    rates: Partial<Pick<ModelCosts, 'inputCostPerToken' | 'outputCostPerToken' | 'cacheReadCostPerToken'>>
  }[]
}

export type PricingCatalogue = {
  prices: ReadonlyMap<string, ModelCosts>
  overrides: ReadonlyMap<string, ModelCosts>
  builtinAliases: Readonly<Record<string, string>>
  userAliases: Readonly<Record<string, string>>
  tiers: readonly PricingTier[]
  routedSegments: ReadonlySet<string>
  sortedPriceKeys: readonly string[]
  sortedOverrideKeys: readonly string[]
  lowercasePrices: ReadonlyMap<string, ModelCosts>
  lowercaseOverrides: ReadonlyMap<string, ModelCosts>
}

export type RepricedCall = {
  /** Original spelling present in the call. */
  model: string
  /** Effective identity after applying a configured Alias. */
  effectiveModel: string
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  webSearchRequests: number
  speed: 'standard' | 'fast'
  recordedCost: number
}

export function capturePricingCatalogue(input: {
  prices: ReadonlyMap<string, ModelCosts>
  overrides: ReadonlyMap<string, ModelCosts>
  builtinAliases: Readonly<Record<string, string>>
  userAliases: Readonly<Record<string, string>>
  tiers: readonly PricingTier[]
  routedSegments: ReadonlySet<string>
  fallbackPrices?: ReadonlyMap<string, ModelCosts>
}): PricingCatalogue {
  const prices = copyCards(input.prices)
  const overrides = copyCards(input.overrides)
  const lowercasePrices = new Map<string, ModelCosts>()
  for (const [key, costs] of prices) {
    if (hasBillableRate(costs) && !lowercasePrices.has(key.toLowerCase())) lowercasePrices.set(key.toLowerCase(), costs)
  }
  for (const [key, costs] of input.fallbackPrices ?? []) {
    if (hasBillableRate(costs) && !lowercasePrices.has(key.toLowerCase()))
      lowercasePrices.set(key.toLowerCase(), { ...costs })
  }
  const lowercaseOverrides = new Map<string, ModelCosts>()
  for (const [key, costs] of overrides) {
    if (!lowercaseOverrides.has(key.toLowerCase())) lowercaseOverrides.set(key.toLowerCase(), costs)
  }
  return {
    prices,
    overrides,
    builtinAliases: { ...input.builtinAliases },
    userAliases: { ...input.userAliases },
    tiers: input.tiers.map(rule => ({
      model: rule.model,
      tiers: rule.tiers.map(tier => ({ ...tier, rates: { ...tier.rates } })),
    })),
    routedSegments: new Set(input.routedSegments),
    sortedPriceKeys: [...prices.keys()].sort((a, b) => b.length - a.length),
    sortedOverrideKeys: [...overrides.keys()].sort((a, b) => b.length - a.length),
    lowercasePrices,
    lowercaseOverrides,
  }
}

function copyCards(cards: ReadonlyMap<string, ModelCosts>): Map<string, ModelCosts> {
  return new Map([...cards].map(([key, costs]) => [key, { ...costs }]))
}

function hasBillableRate(costs: ModelCosts): boolean {
  return (
    costs.inputCostPerToken > 0 ||
    costs.outputCostPerToken > 0 ||
    costs.cacheWriteCostPerToken > 0 ||
    costs.cacheReadCostPerToken > 0
  )
}

/** Names that conventionally identify a model served by a local runtime. */
export function looksLikeLocalModel(name: string): boolean {
  if (name.includes(':') && !name.startsWith('http')) return true
  return /[-_](q[2-8](_[a-z0-9]+)?|bf16|fp16|gguf|f16|f32)$/i.test(name)
}

function canonicalName(model: string): string {
  return stripPinAndDate(model).replace(/^[^/]+\//, '')
}

function alias(catalogue: PricingCatalogue, model: string): string {
  const userAlias = catalogue.userAliases[model]
  if (Object.hasOwn(catalogue.userAliases, model) && userAlias !== undefined) return userAlias

  const builtinAlias = catalogue.builtinAliases[model]
  if (Object.hasOwn(catalogue.builtinAliases, model) && builtinAlias !== undefined) return builtinAlias

  const lowercaseModel = model.toLowerCase()
  const lowercaseAlias = catalogue.builtinAliases[lowercaseModel]
  if (
    lowercaseModel !== model &&
    Object.hasOwn(catalogue.builtinAliases, lowercaseModel) &&
    lowercaseAlias !== undefined
  ) {
    return lowercaseAlias
  }
  return model
}

/** Resolve the captured user or built-in alias used for display naming. */
export function resolveModelNameAlias(catalogue: PricingCatalogue, model: string): string {
  return alias(catalogue, model)
}

function routedCandidates(id: string, segments: ReadonlySet<string>): string[] {
  const out: string[] = []
  let rest = id
  for (;;) {
    const slash = rest.indexOf('/')
    if (slash < 0 || !segments.has(rest.slice(0, slash).toLowerCase())) return out
    rest = rest.slice(slash + 1)
    if (rest) out.push(rest)
  }
}

type Resolution = { costs: ModelCosts; fromUserOverride: boolean }
function exactOverride(catalogue: PricingCatalogue, ...keys: string[]): ModelCosts | undefined {
  for (const key of keys) {
    const value = catalogue.overrides.get(key)
    if (value) return value
  }
  return undefined
}

/** The exact user override that can authoritatively explain a free rate card.
 * Prefix and case-insensitive lookups intentionally do not count: normal price
 * resolution reaches catalogue cards before those fallback forms. */
function exactPriceOverrideFor(catalogue: PricingCatalogue, model: string): ModelCosts | undefined {
  const withPrefix = stripPinAndDate(model)
  const name = canonicalName(model)
  const canonical = alias(catalogue, name)
  return exactOverride(catalogue, model, withPrefix, name, canonical)
}

function resolve(catalogue: PricingCatalogue, model: string): Resolution | null {
  const withPrefix = stripPinAndDate(model)
  const name = canonicalName(model)
  const canonical = alias(catalogue, name)
  const exact = exactOverride(catalogue, model, withPrefix, name, canonical)
  if (exact) return { costs: exact, fromUserOverride: true }
  if (canonical !== name && withPrefix === name) {
    const aliasPrice = catalogue.prices.get(canonical)
    if (aliasPrice) return { costs: aliasPrice, fromUserOverride: false }
  }
  const prefixed = catalogue.prices.get(withPrefix)
  if (prefixed) return { costs: prefixed, fromUserOverride: false }
  const direct = catalogue.prices.get(canonical)
  if (direct) return { costs: direct, fromUserOverride: false }
  for (const key of catalogue.sortedOverrideKeys) {
    if (canonical === key || canonical.startsWith(`${key}-`)) {
      const override = catalogue.overrides.get(key)
      if (override) return { costs: override, fromUserOverride: true }
    }
  }
  for (const key of catalogue.sortedPriceKeys) {
    if (canonical === key || canonical.startsWith(`${key}-`)) {
      const price = catalogue.prices.get(key)
      if (price) return { costs: price, fromUserOverride: false }
    }
  }
  const ciOverride =
    catalogue.lowercaseOverrides.get(canonical.toLowerCase()) ??
    catalogue.lowercaseOverrides.get(withPrefix.toLowerCase())
  if (ciOverride) return { costs: ciOverride, fromUserOverride: true }
  const ciPrice =
    catalogue.lowercasePrices.get(canonical.toLowerCase()) ?? catalogue.lowercasePrices.get(withPrefix.toLowerCase())
  if (ciPrice) return { costs: ciPrice, fromUserOverride: false }

  const suffix = stripVariant(withPrefix)
  if (suffix) {
    const found = resolveWithoutRecursionLoop(catalogue, suffix, model)
    if (found) return found
  }
  const canonicalSuffix = stripVariant(canonical)
  if (canonicalSuffix && canonicalSuffix !== suffix) {
    const found = resolveWithoutRecursionLoop(catalogue, canonicalSuffix, model)
    if (found) return found
  }
  for (const candidate of routedCandidates(withPrefix, catalogue.routedSegments)) {
    const found = resolveWithoutRecursionLoop(catalogue, candidate, model)
    if (found) return found
  }
  return null
}

function resolveWithoutRecursionLoop(
  catalogue: PricingCatalogue,
  candidate: string,
  original: string,
): Resolution | null {
  if (candidate === original) return null
  return resolve(catalogue, candidate)
}

function stripVariant(model: string): string | null {
  const colon = model.replace(/:(thinking|cloud)$/i, '')
  if (colon !== model) return colon
  const tee = model.replace(/-TEE$/i, '')
  return tee !== model ? tee : null
}

function tiered(catalogue: PricingCatalogue, model: string, promptTokens: number, result: Resolution): ModelCosts {
  if (result.fromUserOverride) return result.costs
  const spelled = alias(catalogue, stripPinAndDate(model))
  const rule = catalogue.tiers.find(entry => entry.model === spelled)
  if (!rule) return result.costs
  let matched: PricingTier['tiers'][number] | undefined
  for (const tier of rule.tiers) if (promptTokens >= tier.promptTokensAtLeast) matched = tier
  return matched ? { ...result.costs, ...matched.rates } : result.costs
}

export function getModelCosts(catalogue: PricingCatalogue, model: string): ModelCosts | null {
  return resolve(catalogue, model)?.costs ?? null
}

export type LocalModelSavings = Readonly<Record<string, string>>

export interface UnpricedModelUsage {
  model: string
  calls: number
  tokens: number
}

/** Resolve only an explicitly captured raw model key, preserving the live
 * adapter's existing exact-key mapping semantics. */
export function getLocalSavingsBaseline(localSavings: LocalModelSavings, rawModel: string): string | undefined {
  if (typeof rawModel !== 'string' || !rawModel || !Object.hasOwn(localSavings, rawModel)) return undefined
  return localSavings[rawModel]
}

function hasLocalSavingsMapping(localSavings: LocalModelSavings, model: string): boolean {
  return Boolean(getLocalSavingsBaseline(localSavings, model))
}

/** Models whose $0 cost is correct rather than a pricing gap: local-looking
 * models, models mapped to a local-savings baseline, and models an exact zero-
 * rate user override declares free. */
export function isExpectedFreeModel(
  catalogue: PricingCatalogue,
  localSavings: LocalModelSavings,
  model: string,
): boolean {
  if (looksLikeLocalModel(model)) return true
  if (hasLocalSavingsMapping(localSavings, model)) return true
  const costs = getModelCosts(catalogue, model)
  return Boolean(costs && !hasBillableRate(costs) && exactPriceOverrideFor(catalogue, model))
}

/** Render-time coverage check for aggregated model rows. A render-time check
 * covers cached sessions too and updates when pricing, aliases, or overrides
 * change. Positive-cost rows are not flagged because their model key can be a
 * display name the price catalogue cannot resolve. Zero-cost display-name rows
 * are flagged even if the corresponding raw id prices now: those tokens were
 * recorded at zero. Local-looking models and rows with a savings mapping are
 * excluded because zero is their expected cost. */
export function findUnpricedModels(
  catalogue: PricingCatalogue,
  localSavings: LocalModelSavings,
  rows: Iterable<{ model: string; calls: number; cost: number; tokens?: number }>,
): UnpricedModelUsage[] {
  const out: UnpricedModelUsage[] = []
  for (const row of rows) {
    const { model } = row
    const tokens = row.tokens ?? 0
    if (!model || model === '<synthetic>') continue
    if (row.calls <= 0 && tokens <= 0) continue
    if (row.cost > 0) continue
    if (looksLikeLocalModel(model)) continue
    if (hasLocalSavingsMapping(localSavings, model)) continue
    const costs = getModelCosts(catalogue, model)
    if (costs && hasBillableRate(costs)) continue
    if (costs && exactPriceOverrideFor(catalogue, model)) continue
    out.push({ model, calls: row.calls, tokens })
  }
  return out.sort(
    (a, b) => b.tokens - a.tokens || b.calls - a.calls || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
  )
}

export function getTieredModelCosts(
  catalogue: PricingCatalogue,
  model: string,
  promptTokens: number,
): ModelCosts | null {
  const result = resolve(catalogue, model)
  return result ? tiered(catalogue, model, promptTokens, result) : null
}

export function calculateCostResult(
  catalogue: PricingCatalogue,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  webSearchRequests: number,
  speed: 'standard' | 'fast' = 'standard',
  oneHourCacheCreationTokens = 0,
): { cost: number; priced: boolean } {
  const result = resolve(catalogue, model)
  if (!result) return { cost: 0, priced: false }
  const safe = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0)
  const oneHour = safe(oneHourCacheCreationTokens)
  const cacheWrite = Math.max(safe(cacheCreationTokens), oneHour)
  const freshWrite = Math.max(0, cacheWrite - oneHour)
  const input = safe(inputTokens)
  const rates = tiered(catalogue, model, input + safe(cacheReadTokens) + cacheWrite, result)
  const multiplier = speed === 'fast' ? rates.fastMultiplier : 1
  return {
    priced: true,
    cost:
      multiplier *
      (input * rates.inputCostPerToken +
        safe(outputTokens) * rates.outputCostPerToken +
        freshWrite * rates.cacheWriteCostPerToken +
        oneHour * rates.cacheWriteCostPerToken * 1.6 +
        safe(cacheReadTokens) * rates.cacheReadCostPerToken +
        safe(webSearchRequests) * rates.webSearchCostPerRequest),
  }
}

export function calculateCost(
  catalogue: PricingCatalogue,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheCreationTokens: number,
  cacheReadTokens: number,
  webSearchRequests: number,
  speed: 'standard' | 'fast' = 'standard',
  oneHourCacheCreationTokens = 0,
): number {
  return calculateCostResult(
    catalogue,
    model,
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    webSearchRequests,
    speed,
    oneHourCacheCreationTokens,
  ).cost
}

/** Query-time cost rule shared by aggregation and the Models lens. A configured
 * override wins, aliases are repriced from their target, and recorded scan cost
 * remains authoritative when identity did not change. */
export function calculateRepricedCostResult(
  catalogue: PricingCatalogue,
  config: PricingConfigLookup,
  call: RepricedCall,
): { cost: number; priced: boolean } {
  const override = config.findOverride(call.effectiveModel)
  if (override) {
    const cost =
      call.inputTokens * (override.inputPricePerMillion / 1_000_000) +
      call.outputTokens * (override.outputPricePerMillion / 1_000_000)
    return { cost: Number.isFinite(cost) ? cost : call.recordedCost, priced: true }
  }
  if (call.effectiveModel !== call.model) {
    return calculateCostResult(
      catalogue,
      call.effectiveModel,
      call.inputTokens,
      call.outputTokens,
      call.cacheWriteTokens,
      call.cacheReadTokens,
      call.webSearchRequests,
      call.speed,
    )
  }
  return { cost: call.recordedCost, priced: true }
}
