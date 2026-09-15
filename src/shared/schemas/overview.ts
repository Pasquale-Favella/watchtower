import { z } from 'zod'

export const overviewPeriodSchema = z.enum(['today', 'week', '30days', 'month', 'all', 'lifetime'])
export type OverviewPeriod = z.infer<typeof overviewPeriodSchema>

export const overviewScopeSchema = z.object({
  period: overviewPeriodSchema,
  provider: z.string().optional(),
  range: z.object({ since: z.string(), until: z.string() }).optional(),
})
export type OverviewScope = z.infer<typeof overviewScopeSchema>

export const overviewKpisSchema = z.object({
  cost: z.number(),
  calls: z.number(),
  sessions: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  savingsUSD: z.number(),
  estimatedCostUSD: z.number(),
  oneShotRate: z.number().nullable(),
  cacheHitPercent: z.number(),
})
export type OverviewKpis = z.infer<typeof overviewKpisSchema>

export const overviewDailyEntrySchema = z.object({ date: z.string(), costUSD: z.number(), calls: z.number(), sessions: z.number() })
export type OverviewDailyEntry = z.infer<typeof overviewDailyEntrySchema>

export const overviewModelRowSchema = z.object({
  name: z.string(),
  cost: z.number(),
  calls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  savingsUSD: z.number(),
  /** Raw model ids merged into this row via an Alias. Present only when a
   * merge happened — the lightweight provenance affordance so a merge never
   * hides where spend came from (the Models audit lens is the full trace). */
  sourceModels: z.array(z.string()).optional(),
})
export type OverviewModelRow = z.infer<typeof overviewModelRowSchema>

export const overviewActivityRowSchema = z.object({ name: z.string(), cost: z.number(), turns: z.number(), oneShotRate: z.number().nullable() })
export type OverviewActivityRow = z.infer<typeof overviewActivityRowSchema>

export const overviewToolRowSchema = z.object({ name: z.string(), calls: z.number() })
export type OverviewToolRow = z.infer<typeof overviewToolRowSchema>

export const overviewMcpRowSchema = z.object({ name: z.string(), calls: z.number() })
export type OverviewMcpRow = z.infer<typeof overviewMcpRowSchema>

export const overviewSkillRowSchema = z.object({ name: z.string(), turns: z.number(), cost: z.number() })
export type OverviewSkillRow = z.infer<typeof overviewSkillRowSchema>

export const overviewSubagentRowSchema = z.object({ name: z.string(), calls: z.number(), cost: z.number() })
export type OverviewSubagentRow = z.infer<typeof overviewSubagentRowSchema>

export const overviewRetryTaxRowSchema = z.object({ name: z.string(), taxUSD: z.number(), retries: z.number(), retriesPerEdit: z.number().nullable() })
export type OverviewRetryTaxRow = z.infer<typeof overviewRetryTaxRowSchema>

export const overviewRetryTaxSchema = z.object({
  totalUSD: z.number(),
  retries: z.number(),
  editTurns: z.number(),
  byModel: z.array(overviewRetryTaxRowSchema),
})
export type OverviewRetryTax = z.infer<typeof overviewRetryTaxSchema>

export const overviewRoutingWasteRowSchema = z.object({
  name: z.string(),
  actualUSD: z.number(),
  counterfactualUSD: z.number(),
  savingsUSD: z.number(),
})
export type OverviewRoutingWasteRow = z.infer<typeof overviewRoutingWasteRowSchema>

export const overviewRoutingWasteSchema = z.object({
  baselineModel: z.string(),
  baselineCostPerEdit: z.number(),
  totalSavingsUSD: z.number(),
  byModel: z.array(overviewRoutingWasteRowSchema),
})
export type OverviewRoutingWaste = z.infer<typeof overviewRoutingWasteSchema>

export const efficiencyGradeSchema = z.enum(['A+', 'A', 'B', 'C', 'D', 'F'])
export type EfficiencyGrade = z.infer<typeof efficiencyGradeSchema>

export const overviewEfficiencySchema = z.object({
  score: z.number(),
  grade: efficiencyGradeSchema,
  oneShotRate: z.number().nullable(),
  retryTax: overviewRetryTaxSchema,
  routingWaste: overviewRoutingWasteSchema,
  pricingCoverage: z.number(),
})
export type OverviewEfficiency = z.infer<typeof overviewEfficiencySchema>

export const overviewReworkedFileSchema = z.object({ path: z.string(), sessions: z.number(), edits: z.number() })
export type OverviewReworkedFile = z.infer<typeof overviewReworkedFileSchema>

export const overviewWorkflowSchema = z.object({
  corrections: z.number(),
  userTurns: z.number(),
  correctionRate: z.number().nullable(),
  medianTimeToFirstEditMs: z.number().nullable(),
  topReworkedFiles: z.array(overviewReworkedFileSchema),
})
export type OverviewWorkflow = z.infer<typeof overviewWorkflowSchema>

export const overviewUnpricedModelSchema = z.object({ model: z.string(), calls: z.number(), tokens: z.number() })
export type OverviewUnpricedModel = z.infer<typeof overviewUnpricedModelSchema>

export const overviewLocalSavingsRowSchema = z.object({
  name: z.string(),
  calls: z.number(),
  actualUSD: z.number(),
  savingsUSD: z.number(),
  baselineModel: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
})
export type OverviewLocalSavingsRow = z.infer<typeof overviewLocalSavingsRowSchema>

export const overviewLocalSavingsProviderRowSchema = z.object({ name: z.string(), calls: z.number(), savingsUSD: z.number() })
export type OverviewLocalSavingsProviderRow = z.infer<typeof overviewLocalSavingsProviderRowSchema>

export const overviewLocalModelSavingsSchema = z.object({
  totalUSD: z.number(),
  calls: z.number(),
  byModel: z.array(overviewLocalSavingsRowSchema),
  byProvider: z.array(overviewLocalSavingsProviderRowSchema),
})
export type OverviewLocalModelSavings = z.infer<typeof overviewLocalModelSavingsSchema>

export const overviewPayloadSchema = z.object({
  kpis: overviewKpisSchema,
  daily: z.array(overviewDailyEntrySchema),
  dataStart: z.string().nullable(),
  models: z.array(overviewModelRowSchema),
  activities: z.array(overviewActivityRowSchema),
  tools: z.array(overviewToolRowSchema),
  mcpServers: z.array(overviewMcpRowSchema),
  skills: z.array(overviewSkillRowSchema),
  subagents: z.array(overviewSubagentRowSchema),
  efficiency: overviewEfficiencySchema,
  workflow: overviewWorkflowSchema,
  unpricedModels: z.array(overviewUnpricedModelSchema),
  localModelSavings: overviewLocalModelSavingsSchema,
})
export type OverviewPayload = z.infer<typeof overviewPayloadSchema>
