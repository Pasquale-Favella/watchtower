import * as Schema from 'effect/Schema'

const finiteNumber = Schema.Finite
const writable = Schema.mutableKey
const mutableArray = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.mutable(Schema.Array(schema))
const text = Schema.String
const nullableNumber = Schema.NullOr(finiteNumber)

export const overviewPeriodSchema = Schema.Literals(['today', 'week', '30days', 'month', 'all', 'lifetime'])
export type OverviewPeriod = Schema.Schema.Type<typeof overviewPeriodSchema>

export const overviewScopeSchema = Schema.Struct({
  period: writable(overviewPeriodSchema),
  provider: writable(Schema.optional(text)),
  range: writable(Schema.optional(Schema.Struct({ since: writable(text), until: writable(text) }))),
})
export type OverviewScope = Schema.Schema.Type<typeof overviewScopeSchema>

export const overviewKpisSchema = Schema.Struct({
  cost: writable(finiteNumber),
  calls: writable(finiteNumber),
  sessions: writable(finiteNumber),
  inputTokens: writable(finiteNumber),
  outputTokens: writable(finiteNumber),
  cacheReadTokens: writable(finiteNumber),
  cacheWriteTokens: writable(finiteNumber),
  savingsUSD: writable(finiteNumber),
  estimatedCostUSD: writable(finiteNumber),
  oneShotRate: writable(nullableNumber),
  cacheHitPercent: writable(finiteNumber),
})
export type OverviewKpis = Schema.Schema.Type<typeof overviewKpisSchema>

export const overviewDailyEntrySchema = Schema.Struct({
  date: writable(text),
  costUSD: writable(finiteNumber),
  calls: writable(finiteNumber),
  sessions: writable(finiteNumber),
})
export type OverviewDailyEntry = Schema.Schema.Type<typeof overviewDailyEntrySchema>

export const overviewModelRowSchema = Schema.Struct({
  name: writable(text),
  cost: writable(finiteNumber),
  calls: writable(finiteNumber),
  inputTokens: writable(finiteNumber),
  outputTokens: writable(finiteNumber),
  savingsUSD: writable(finiteNumber),
  sourceModels: writable(Schema.optional(mutableArray(text))),
})
export type OverviewModelRow = Schema.Schema.Type<typeof overviewModelRowSchema>

export const overviewActivityRowSchema = Schema.Struct({
  name: writable(text),
  cost: writable(finiteNumber),
  turns: writable(finiteNumber),
  oneShotRate: writable(nullableNumber),
})
export type OverviewActivityRow = Schema.Schema.Type<typeof overviewActivityRowSchema>
export const overviewToolRowSchema = Schema.Struct({ name: writable(text), calls: writable(finiteNumber) })
export type OverviewToolRow = Schema.Schema.Type<typeof overviewToolRowSchema>
export const overviewMcpRowSchema = Schema.Struct({ name: writable(text), calls: writable(finiteNumber) })
export type OverviewMcpRow = Schema.Schema.Type<typeof overviewMcpRowSchema>
export const overviewSkillRowSchema = Schema.Struct({
  name: writable(text),
  turns: writable(finiteNumber),
  cost: writable(finiteNumber),
})
export type OverviewSkillRow = Schema.Schema.Type<typeof overviewSkillRowSchema>
export const overviewSubagentRowSchema = Schema.Struct({
  name: writable(text),
  calls: writable(finiteNumber),
  cost: writable(finiteNumber),
})
export type OverviewSubagentRow = Schema.Schema.Type<typeof overviewSubagentRowSchema>

export const overviewRetryTaxRowSchema = Schema.Struct({
  name: writable(text),
  taxUSD: writable(finiteNumber),
  retries: writable(finiteNumber),
  retriesPerEdit: writable(nullableNumber),
})
export type OverviewRetryTaxRow = Schema.Schema.Type<typeof overviewRetryTaxRowSchema>
export const overviewRetryTaxSchema = Schema.Struct({
  totalUSD: writable(finiteNumber),
  retries: writable(finiteNumber),
  editTurns: writable(finiteNumber),
  byModel: writable(mutableArray(overviewRetryTaxRowSchema)),
})
export type OverviewRetryTax = Schema.Schema.Type<typeof overviewRetryTaxSchema>
export const overviewRoutingWasteRowSchema = Schema.Struct({
  name: writable(text),
  actualUSD: writable(finiteNumber),
  counterfactualUSD: writable(finiteNumber),
  savingsUSD: writable(finiteNumber),
})
export type OverviewRoutingWasteRow = Schema.Schema.Type<typeof overviewRoutingWasteRowSchema>
export const overviewRoutingWasteSchema = Schema.Struct({
  baselineModel: writable(text),
  baselineCostPerEdit: writable(finiteNumber),
  totalSavingsUSD: writable(finiteNumber),
  byModel: writable(mutableArray(overviewRoutingWasteRowSchema)),
})
export type OverviewRoutingWaste = Schema.Schema.Type<typeof overviewRoutingWasteSchema>
export const efficiencyGradeSchema = Schema.Literals(['A+', 'A', 'B', 'C', 'D', 'F'])
export type EfficiencyGrade = Schema.Schema.Type<typeof efficiencyGradeSchema>
export const overviewEfficiencySchema = Schema.Struct({
  score: writable(finiteNumber),
  grade: writable(efficiencyGradeSchema),
  oneShotRate: writable(nullableNumber),
  retryTax: writable(overviewRetryTaxSchema),
  routingWaste: writable(overviewRoutingWasteSchema),
  pricingCoverage: writable(finiteNumber),
})
export type OverviewEfficiency = Schema.Schema.Type<typeof overviewEfficiencySchema>

export const overviewReworkedFileSchema = Schema.Struct({
  path: writable(text),
  sessions: writable(finiteNumber),
  edits: writable(finiteNumber),
})
export type OverviewReworkedFile = Schema.Schema.Type<typeof overviewReworkedFileSchema>
export const overviewWorkflowSchema = Schema.Struct({
  corrections: writable(finiteNumber),
  userTurns: writable(finiteNumber),
  correctionRate: writable(nullableNumber),
  medianTimeToFirstEditMs: writable(nullableNumber),
  topReworkedFiles: writable(mutableArray(overviewReworkedFileSchema)),
})
export type OverviewWorkflow = Schema.Schema.Type<typeof overviewWorkflowSchema>
export const overviewUnpricedModelSchema = Schema.Struct({
  model: writable(text),
  calls: writable(finiteNumber),
  tokens: writable(finiteNumber),
})
export type OverviewUnpricedModel = Schema.Schema.Type<typeof overviewUnpricedModelSchema>
export const overviewLocalSavingsRowSchema = Schema.Struct({
  name: writable(text),
  calls: writable(finiteNumber),
  actualUSD: writable(finiteNumber),
  savingsUSD: writable(finiteNumber),
  baselineModel: writable(text),
  inputTokens: writable(finiteNumber),
  outputTokens: writable(finiteNumber),
})
export type OverviewLocalSavingsRow = Schema.Schema.Type<typeof overviewLocalSavingsRowSchema>
export const overviewLocalSavingsProviderRowSchema = Schema.Struct({
  name: writable(text),
  calls: writable(finiteNumber),
  savingsUSD: writable(finiteNumber),
})
export type OverviewLocalSavingsProviderRow = Schema.Schema.Type<typeof overviewLocalSavingsProviderRowSchema>
export const overviewLocalModelSavingsSchema = Schema.Struct({
  totalUSD: writable(finiteNumber),
  calls: writable(finiteNumber),
  byModel: writable(mutableArray(overviewLocalSavingsRowSchema)),
  byProvider: writable(mutableArray(overviewLocalSavingsProviderRowSchema)),
})
export type OverviewLocalModelSavings = Schema.Schema.Type<typeof overviewLocalModelSavingsSchema>

export const overviewPayloadSchema = Schema.Struct({
  kpis: writable(overviewKpisSchema),
  daily: writable(mutableArray(overviewDailyEntrySchema)),
  dataStart: writable(Schema.NullOr(text)),
  models: writable(mutableArray(overviewModelRowSchema)),
  activities: writable(mutableArray(overviewActivityRowSchema)),
  tools: writable(mutableArray(overviewToolRowSchema)),
  mcpServers: writable(mutableArray(overviewMcpRowSchema)),
  skills: writable(mutableArray(overviewSkillRowSchema)),
  subagents: writable(mutableArray(overviewSubagentRowSchema)),
  efficiency: writable(overviewEfficiencySchema),
  workflow: writable(overviewWorkflowSchema),
  unpricedModels: writable(mutableArray(overviewUnpricedModelSchema)),
  localModelSavings: writable(overviewLocalModelSavingsSchema),
})
export type OverviewPayload = Schema.Schema.Type<typeof overviewPayloadSchema>
