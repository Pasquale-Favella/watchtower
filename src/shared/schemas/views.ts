import { z } from 'zod'

export const providerRowSchema = z.object({
  name: z.string(),
  cost: z.number(),
  calls: z.number(),
  sessions: z.number(),
})
export type ProviderRow = z.infer<typeof providerRowSchema>

export const dashboardViewsSchema = z.object({
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
})
export type DashboardViews = z.infer<typeof dashboardViewsSchema>

export const projectRowSchema = z.object({
  project: z.string(),
  projectPath: z.string(),
  repoUrl: z.string().optional(),
  cost: z.number(),
  calls: z.number(),
  sessions: z.number(),
  firstTimestamp: z.string(),
  lastTimestamp: z.string(),
})
export type ProjectRow = z.infer<typeof projectRowSchema>

export const sessionRowSchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  project: z.string(),
  provider: z.string(),
  models: z.array(z.string()),
  cost: z.number(),
  savingsUSD: z.number(),
  calls: z.number(),
  turns: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  startedAt: z.string(),
  endedAt: z.string(),
})
export type SessionRow = z.infer<typeof sessionRowSchema>

export const skillRowSchema = z.object({
  name: z.string(),
  turns: z.number(),
  cost: z.number(),
  savingsUSD: z.number(),
})
export type SkillRow = z.infer<typeof skillRowSchema>

export const subagentRowSchema = z.object({
  name: z.string(),
  calls: z.number(),
  cost: z.number(),
  savingsUSD: z.number(),
})
export type SubagentRow = z.infer<typeof subagentRowSchema>

export const analyticalViewsSchema = z.object({
  providers: z.array(providerRowSchema),
  models: z.array(z.object({ name: z.string(), cost: z.number(), calls: z.number() })),
  categories: z.array(z.object({ name: z.string(), cost: z.number(), turns: z.number() })),
  skills: z.array(skillRowSchema),
  subagents: z.array(subagentRowSchema),
})
export type AnalyticalViews = z.infer<typeof analyticalViewsSchema>

export const searchHitSchema = z.object({
  sessionId: z.string(),
  project: z.string(),
  provider: z.string(),
  timestamp: z.string(),
  kind: z.enum(['message', 'bash']),
  snippet: z.string(),
})
export type SearchHit = z.infer<typeof searchHitSchema>

export const sessionDetailCallSchema = z.object({
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

export const sessionDetailTurnSchema = z.object({
  timestamp: z.string(),
  userMessage: z.string(),
  category: z.string(),
  gitBranch: z.string().optional(),
  prRefs: z.array(z.string()),
  retries: z.number(),
  hasEdits: z.boolean(),
  assistantCalls: z.array(sessionDetailCallSchema),
})

export const sessionDetailSchema = z.object({
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
  modelBreakdown: z.record(z.string(), z.object({ calls: z.number(), costUSD: z.number() })),
  turns: z.array(sessionDetailTurnSchema),
})
export type SessionDetail = z.infer<typeof sessionDetailSchema>
