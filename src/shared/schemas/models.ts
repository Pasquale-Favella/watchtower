import { z } from 'zod'

export const modelCostsSchema = z.object({
  inputCostPerToken: z.number(),
  outputCostPerToken: z.number(),
  cacheWriteCostPerToken: z.number(),
  cacheReadCostPerToken: z.number(),
  webSearchCostPerRequest: z.number(),
  fastMultiplier: z.number(),
})
export type ModelCosts = z.infer<typeof modelCostsSchema>

export const modelAliasSchema = z.object({
  model: z.string(),
  aliasOf: z.string(),
})
export type ModelAlias = z.infer<typeof modelAliasSchema>

export const priceOverrideSchema = z.object({
  model: z.string(),
  inputPricePerMillion: z.number(),
  outputPricePerMillion: z.number(),
})
export type PriceOverride = z.infer<typeof priceOverrideSchema>

export const modelsConfigSchema = z.object({
  aliases: z.array(modelAliasSchema),
  overrides: z.array(priceOverrideSchema),
})
export type ModelsConfig = z.infer<typeof modelsConfigSchema>

/** The Price override rates applied to a Models row's effective model.
/// Present only when an override prices the row — the affordance the Models
/// section uses to show "repriced" state with edit/remove actions. */
export const rowOverrideSchema = z.object({
  inputPricePerMillion: z.number(),
  outputPricePerMillion: z.number(),
})
export type RowOverride = z.infer<typeof rowOverrideSchema>

export const modelReportRowSchema = z.object({
  provider: z.string(),
  model: z.string(),
  modelDisplayName: z.string(),
  category: z.string().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheWriteTokens: z.number(),
  cacheReadTokens: z.number(),
  totalTokens: z.number(),
  costUSD: z.number(),
  savingsUSD: z.number(),
  savingsBaselineModel: z.string(),
  calls: z.number(),
  /** Raw model ids folded into this row via an Alias. Present only when a
   * merge happened — lets the Models section show the original names with
   * their alias target and offer retarget/remove per source. */
  sourceModels: z.array(z.string()).optional(),
  /** The Price override rates pricing this row's effective model. Present
   * only when an override applies — the "repriced" state with edit/remove. */
  override: rowOverrideSchema.optional(),
})
export type ModelReportRow = z.infer<typeof modelReportRowSchema>

export const auditRowSchema = z.object({
  provider: z.string(),
  model: z.string(),
  modelDisplayName: z.string(),
  calls: z.number(),
  raw: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    reasoningTokens: z.number(),
    cacheCreationInputTokens: z.number(),
    cacheReadInputTokens: z.number(),
    cachedInputTokens: z.number(),
    webSearchRequests: z.number(),
  }),
  displayed: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    cacheWriteTokens: z.number(),
    cacheReadTokens: z.number(),
  }),
  rates: modelCostsSchema.nullable(),
  cost: z.object({
    input: z.number(),
    output: z.number(),
    cacheWrite: z.number(),
    cacheRead: z.number(),
    webSearch: z.number(),
    recomputedTotalUSD: z.number(),
  }),
  attributedCostUSD: z.number(),
  /** Alias target for this raw model, when an Alias merges it elsewhere.
   * The audit lens keeps the original name; this names where it folds to. */
  aliasOf: z.string().optional(),
  /** The Price override rates pricing this row (on the effective model).
   * Present only when an override applies. */
  override: rowOverrideSchema.optional(),
})
export type AuditRow = z.infer<typeof auditRowSchema>

export const modelsPayloadSchema = z.object({
  byModel: z.array(modelReportRowSchema),
  byTask: z.array(modelReportRowSchema),
  audit: z.array(auditRowSchema),
})
export type ModelsPayload = z.infer<typeof modelsPayloadSchema>
