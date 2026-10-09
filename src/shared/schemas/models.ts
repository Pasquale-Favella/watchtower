import * as Schema from 'effect/Schema'

import { type ModelAlias, modelAliasSchema, type PriceOverride, priceOverrideSchema } from './ledger.js'

const finiteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()))
const writable = Schema.mutableKey
const mutableArray = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.mutable(Schema.Array(schema))

export { modelAliasSchema, priceOverrideSchema }
export type { ModelAlias, PriceOverride }

export const modelCostsSchema = Schema.Struct({
  inputCostPerToken: writable(finiteNumber),
  outputCostPerToken: writable(finiteNumber),
  cacheWriteCostPerToken: writable(finiteNumber),
  cacheReadCostPerToken: writable(finiteNumber),
  webSearchCostPerRequest: writable(finiteNumber),
  fastMultiplier: writable(finiteNumber),
})
export type ModelCosts = Schema.Schema.Type<typeof modelCostsSchema>

export const modelsConfigSchema = Schema.Struct({
  aliases: writable(mutableArray(modelAliasSchema)),
  overrides: writable(mutableArray(priceOverrideSchema)),
})
export type ModelsConfig = Schema.Schema.Type<typeof modelsConfigSchema>

/** The Price override rates applied to a Models row's effective model.
 * Present only when an override prices the row — the affordance the Models
 * section uses to show "repriced" state with edit/remove actions. */
export const rowOverrideSchema = Schema.Struct({
  inputPricePerMillion: writable(finiteNumber),
  outputPricePerMillion: writable(finiteNumber),
})
export type RowOverride = Schema.Schema.Type<typeof rowOverrideSchema>

export const modelReportRowSchema = Schema.Struct({
  provider: writable(Schema.String),
  model: writable(Schema.String),
  modelDisplayName: writable(Schema.String),
  category: writable(Schema.NullOr(Schema.String)),
  inputTokens: writable(finiteNumber),
  outputTokens: writable(finiteNumber),
  cacheWriteTokens: writable(finiteNumber),
  cacheReadTokens: writable(finiteNumber),
  totalTokens: writable(finiteNumber),
  costUSD: writable(finiteNumber),
  savingsUSD: writable(finiteNumber),
  savingsBaselineModel: writable(Schema.String),
  calls: writable(finiteNumber),
  /** Raw model ids folded into this row via an Alias. Present only when a
   * merge happened — lets the Models section show the original names with
   * their alias target and offer retarget/remove per source. */
  sourceModels: writable(Schema.optional(mutableArray(Schema.String))),
  /** The Price override rates pricing this row's effective model. Present
   * only when an override applies — the "repriced" state with edit/remove. */
  override: writable(Schema.optional(rowOverrideSchema)),
})
export type ModelReportRow = Schema.Schema.Type<typeof modelReportRowSchema>

export const auditRowSchema = Schema.Struct({
  provider: writable(Schema.String),
  model: writable(Schema.String),
  modelDisplayName: writable(Schema.String),
  calls: writable(finiteNumber),
  raw: writable(
    Schema.Struct({
      inputTokens: writable(finiteNumber),
      outputTokens: writable(finiteNumber),
      reasoningTokens: writable(finiteNumber),
      cacheCreationInputTokens: writable(finiteNumber),
      cacheReadInputTokens: writable(finiteNumber),
      cachedInputTokens: writable(finiteNumber),
      webSearchRequests: writable(finiteNumber),
    }),
  ),
  displayed: writable(
    Schema.Struct({
      inputTokens: writable(finiteNumber),
      outputTokens: writable(finiteNumber),
      cacheWriteTokens: writable(finiteNumber),
      cacheReadTokens: writable(finiteNumber),
    }),
  ),
  rates: writable(Schema.NullOr(modelCostsSchema)),
  cost: writable(
    Schema.Struct({
      input: writable(finiteNumber),
      output: writable(finiteNumber),
      cacheWrite: writable(finiteNumber),
      cacheRead: writable(finiteNumber),
      webSearch: writable(finiteNumber),
      recomputedTotalUSD: writable(finiteNumber),
    }),
  ),
  attributedCostUSD: writable(finiteNumber),
  /** Alias target for this raw model, when an Alias merges it elsewhere.
   * The audit lens keeps the original name; this names where it folds to. */
  aliasOf: writable(Schema.optional(Schema.String)),
  /** The Price override rates pricing this row (on the effective model).
   * Present only when an override applies. */
  override: writable(Schema.optional(rowOverrideSchema)),
})
export type AuditRow = Schema.Schema.Type<typeof auditRowSchema>

export const modelsPayloadSchema = Schema.Struct({
  byModel: writable(mutableArray(modelReportRowSchema)),
  byTask: writable(mutableArray(modelReportRowSchema)),
  audit: writable(mutableArray(auditRowSchema)),
})
export type ModelsPayload = Schema.Schema.Type<typeof modelsPayloadSchema>
