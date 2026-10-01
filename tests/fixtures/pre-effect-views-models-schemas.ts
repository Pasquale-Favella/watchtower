import { z } from 'zod'

// Frozen copies of the contracts at 5fae740, kept as the parity oracle while
// Effect Schema owns the production definitions.
export const preEffectModels = {
  modelCostsSchema: z.object({
    inputCostPerToken: z.number(),
    outputCostPerToken: z.number(),
    cacheWriteCostPerToken: z.number(),
    cacheReadCostPerToken: z.number(),
    webSearchCostPerRequest: z.number(),
    fastMultiplier: z.number(),
  }),
  modelAliasSchema: z.object({ model: z.string(), aliasOf: z.string() }),
  priceOverrideSchema: z.object({
    model: z.string(),
    inputPricePerMillion: z.number(),
    outputPricePerMillion: z.number(),
  }),
  rowOverrideSchema: z.object({
    inputPricePerMillion: z.number(),
    outputPricePerMillion: z.number(),
  }),
}

const { modelCostsSchema, modelAliasSchema, priceOverrideSchema, rowOverrideSchema } = preEffectModels

const modelReportRowSchema = z.object({
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
  sourceModels: z.array(z.string()).optional(),
  override: rowOverrideSchema.optional(),
})

const auditRowSchema = z.object({
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
  aliasOf: z.string().optional(),
  override: rowOverrideSchema.optional(),
})

export const preEffectModelsContracts = {
  ...preEffectModels,
  modelsConfigSchema: z.object({ aliases: z.array(modelAliasSchema), overrides: z.array(priceOverrideSchema) }),
  modelReportRowSchema,
  auditRowSchema,
  modelsPayloadSchema: z.object({
    byModel: z.array(modelReportRowSchema),
    byTask: z.array(modelReportRowSchema),
    audit: z.array(auditRowSchema),
  }),
}

const providerRowSchema = z.object({
  name: z.string(),
  cost: z.number(),
  calls: z.number(),
  sessions: z.number(),
})
const skillRowSchema = z.object({ name: z.string(), turns: z.number(), cost: z.number(), savingsUSD: z.number() })
const subagentRowSchema = z.object({ name: z.string(), calls: z.number(), cost: z.number(), savingsUSD: z.number() })
const modelBreakdownRowSchema = z.object({ calls: z.number(), costUSD: z.number() })

const sessionDetailCallSchema = z.object({
  provider: z.string(),
  model: z.string(),
  costUSD: z.number(),
  isEstimated: z.boolean().optional(),
  savingsUSD: z.number().optional(),
  speed: z.enum(['standard', 'fast']),
  hasPlanMode: z.boolean(),
  tools: z.array(z.string()),
  mcpTools: z.array(z.string()),
  skills: z.array(z.string()),
  subagentTypes: z.array(z.string()),
  usage: z.object({
    inputTokens: z.number(),
    outputTokens: z.number(),
    reasoningTokens: z.number(),
    cacheReadInputTokens: z.number(),
    cacheCreationInputTokens: z.number(),
  }),
})

const sessionDetailTurnSchema = z.object({
  timestamp: z.string(),
  userMessage: z.string(),
  category: z.string(),
  gitBranch: z.string().optional(),
  prRefs: z.array(z.string()),
  retries: z.number(),
  hasEdits: z.boolean(),
  assistantCalls: z.array(sessionDetailCallSchema),
})

export const preEffectViewsContracts = {
  providerRowSchema,
  dashboardViewsSchema: z.object({
    kpis: z.object({
      totalCost: z.number(),
      totalEstimatedCost: z.number(),
      totalSavings: z.number(),
      totalProxiedCost: z.number(),
      totalCalls: z.number(),
      totalSessions: z.number(),
      totalProjects: z.number(),
      totalInputTokens: z.number(),
      totalOutputTokens: z.number(),
      totalCacheReadTokens: z.number(),
      totalCacheWriteTokens: z.number(),
      totalReasoningTokens: z.number(),
    }),
    costOverTime: z.array(z.object({ date: z.string(), cost: z.number() })),
    byProvider: z.array(providerRowSchema),
    byModel: z.array(z.object({ name: z.string(), cost: z.number(), calls: z.number() })),
    byProject: z.array(z.object({ name: z.string(), cost: z.number(), calls: z.number() })),
    byCategory: z.array(z.object({ name: z.string(), cost: z.number(), turns: z.number() })),
  }),
  projectRowSchema: z.object({
    project: z.string(),
    projectPath: z.string(),
    repoUrl: z.string().optional(),
    cost: z.number(),
    calls: z.number(),
    sessions: z.number(),
    firstTimestamp: z.string(),
    lastTimestamp: z.string(),
  }),
  sessionRowSchema: z.object({
    sessionId: z.string(),
    title: z.string(),
    project: z.string(),
    provider: z.string(),
    models: z.array(z.string()),
    modelProvenance: z.record(z.string(), z.array(z.string())).optional(),
    cost: z.number(),
    savingsUSD: z.number(),
    calls: z.number(),
    turns: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    startedAt: z.string(),
    endedAt: z.string(),
  }),
  skillRowSchema,
  subagentRowSchema,
  analyticalViewsSchema: z.object({
    providers: z.array(providerRowSchema),
    models: z.array(z.object({ name: z.string(), cost: z.number(), calls: z.number() })),
    categories: z.array(z.object({ name: z.string(), cost: z.number(), turns: z.number() })),
    skills: z.array(skillRowSchema),
    subagents: z.array(subagentRowSchema),
  }),
  searchHitSchema: z.object({
    sessionId: z.string(),
    project: z.string(),
    provider: z.string(),
    timestamp: z.string(),
    kind: z.enum(['message', 'bash']),
    snippet: z.string(),
  }),
  sessionDetailCallSchema,
  sessionDetailTurnSchema,
  sessionDetailSchema: z.object({
    sessionId: z.string(),
    project: z.string(),
    provider: z.string(),
    title: z.string(),
    workingDirectory: z.string().optional(),
    firstTimestamp: z.string(),
    lastTimestamp: z.string(),
    totalCostUSD: z.number(),
    totalEstimatedCostUSD: z.number(),
    totalSavingsUSD: z.number(),
    totalInputTokens: z.number(),
    totalOutputTokens: z.number(),
    totalCacheReadTokens: z.number(),
    totalCacheWriteTokens: z.number(),
    totalReasoningTokens: z.number(),
    apiCalls: z.number(),
    prLinks: z.array(z.string()),
    modelBreakdown: z.record(z.string(), modelBreakdownRowSchema),
    turns: z.array(sessionDetailTurnSchema),
  }),
}
