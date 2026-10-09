import * as Schema from 'effect/Schema'

const finiteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()))
const writable = Schema.mutableKey
const mutableArray = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.mutable(Schema.Array(schema))

export const providerRowSchema = Schema.Struct({
  name: writable(Schema.String),
  cost: writable(finiteNumber),
  calls: writable(finiteNumber),
  sessions: writable(finiteNumber),
})
export type ProviderRow = Schema.Schema.Type<typeof providerRowSchema>

export const dashboardViewsSchema = Schema.Struct({
  kpis: writable(
    Schema.Struct({
      totalCost: writable(finiteNumber),
      totalEstimatedCost: writable(finiteNumber),
      totalSavings: writable(finiteNumber),
      totalProxiedCost: writable(finiteNumber),
      totalCalls: writable(finiteNumber),
      totalSessions: writable(finiteNumber),
      totalProjects: writable(finiteNumber),
      totalInputTokens: writable(finiteNumber),
      totalOutputTokens: writable(finiteNumber),
      totalCacheReadTokens: writable(finiteNumber),
      totalCacheWriteTokens: writable(finiteNumber),
      totalReasoningTokens: writable(finiteNumber),
    }),
  ),
  costOverTime: writable(mutableArray(Schema.Struct({ date: writable(Schema.String), cost: writable(finiteNumber) }))),
  byProvider: writable(mutableArray(providerRowSchema)),
  byModel: writable(
    mutableArray(
      Schema.Struct({ name: writable(Schema.String), cost: writable(finiteNumber), calls: writable(finiteNumber) }),
    ),
  ),
  byProject: writable(
    mutableArray(
      Schema.Struct({ name: writable(Schema.String), cost: writable(finiteNumber), calls: writable(finiteNumber) }),
    ),
  ),
  byCategory: writable(
    mutableArray(
      Schema.Struct({ name: writable(Schema.String), cost: writable(finiteNumber), turns: writable(finiteNumber) }),
    ),
  ),
})
export type DashboardViews = Schema.Schema.Type<typeof dashboardViewsSchema>

export const projectRowSchema = Schema.Struct({
  project: writable(Schema.String),
  projectPath: writable(Schema.String),
  repoUrl: writable(Schema.optional(Schema.String)),
  cost: writable(finiteNumber),
  calls: writable(finiteNumber),
  sessions: writable(finiteNumber),
  firstTimestamp: writable(Schema.String),
  lastTimestamp: writable(Schema.String),
})
export type ProjectRow = Schema.Schema.Type<typeof projectRowSchema>

export const sessionRowSchema = Schema.Struct({
  sessionId: writable(Schema.String),
  title: writable(Schema.String),
  project: writable(Schema.String),
  provider: writable(Schema.String),
  models: writable(mutableArray(Schema.String)),
  /** Per-model raw feeders for Alias-merged rows (`models` holds the merged
   * identity). Present only when a merge happened. */
  modelProvenance: writable(Schema.optional(Schema.Record(Schema.String, mutableArray(Schema.String)))),
  cost: writable(finiteNumber),
  savingsUSD: writable(finiteNumber),
  calls: writable(finiteNumber),
  turns: writable(finiteNumber),
  inputTokens: writable(finiteNumber),
  outputTokens: writable(finiteNumber),
  startedAt: writable(Schema.String),
  endedAt: writable(Schema.String),
})
export type SessionRow = Schema.Schema.Type<typeof sessionRowSchema>

export const skillRowSchema = Schema.Struct({
  name: writable(Schema.String),
  turns: writable(finiteNumber),
  cost: writable(finiteNumber),
  savingsUSD: writable(finiteNumber),
})
export type SkillRow = Schema.Schema.Type<typeof skillRowSchema>

export const subagentRowSchema = Schema.Struct({
  name: writable(Schema.String),
  calls: writable(finiteNumber),
  cost: writable(finiteNumber),
  savingsUSD: writable(finiteNumber),
})
export type SubagentRow = Schema.Schema.Type<typeof subagentRowSchema>

export const analyticalViewsSchema = Schema.Struct({
  providers: writable(mutableArray(providerRowSchema)),
  models: writable(
    mutableArray(
      Schema.Struct({ name: writable(Schema.String), cost: writable(finiteNumber), calls: writable(finiteNumber) }),
    ),
  ),
  categories: writable(
    mutableArray(
      Schema.Struct({ name: writable(Schema.String), cost: writable(finiteNumber), turns: writable(finiteNumber) }),
    ),
  ),
  skills: writable(mutableArray(skillRowSchema)),
  subagents: writable(mutableArray(subagentRowSchema)),
})
export type AnalyticalViews = Schema.Schema.Type<typeof analyticalViewsSchema>

export const searchHitSchema = Schema.Struct({
  sessionId: writable(Schema.String),
  project: writable(Schema.String),
  provider: writable(Schema.String),
  timestamp: writable(Schema.String),
  kind: writable(Schema.Literals(['message', 'bash'])),
  snippet: writable(Schema.String),
})
export type SearchHit = Schema.Schema.Type<typeof searchHitSchema>

export const sessionDetailCallSchema = Schema.Struct({
  provider: writable(Schema.String),
  model: writable(Schema.String),
  costUSD: writable(finiteNumber),
  isEstimated: writable(Schema.optional(Schema.Boolean)),
  savingsUSD: writable(Schema.optional(finiteNumber)),
  speed: writable(Schema.Literals(['standard', 'fast'])),
  hasPlanMode: writable(Schema.Boolean),
  tools: writable(mutableArray(Schema.String)),
  mcpTools: writable(mutableArray(Schema.String)),
  skills: writable(mutableArray(Schema.String)),
  subagentTypes: writable(mutableArray(Schema.String)),
  usage: writable(
    Schema.Struct({
      inputTokens: writable(finiteNumber),
      outputTokens: writable(finiteNumber),
      reasoningTokens: writable(finiteNumber),
      cacheReadInputTokens: writable(finiteNumber),
      cacheCreationInputTokens: writable(finiteNumber),
    }),
  ),
})

export const sessionDetailTurnSchema = Schema.Struct({
  timestamp: writable(Schema.String),
  userMessage: writable(Schema.String),
  category: writable(Schema.String),
  gitBranch: writable(Schema.optional(Schema.String)),
  prRefs: writable(mutableArray(Schema.String)),
  retries: writable(finiteNumber),
  hasEdits: writable(Schema.Boolean),
  assistantCalls: writable(mutableArray(sessionDetailCallSchema)),
})

export const sessionDetailSchema = Schema.Struct({
  sessionId: writable(Schema.String),
  project: writable(Schema.String),
  provider: writable(Schema.String),
  title: writable(Schema.String),
  workingDirectory: writable(Schema.optional(Schema.String)),
  firstTimestamp: writable(Schema.String),
  lastTimestamp: writable(Schema.String),
  totalCostUSD: writable(finiteNumber),
  totalEstimatedCostUSD: writable(finiteNumber),
  totalSavingsUSD: writable(finiteNumber),
  totalInputTokens: writable(finiteNumber),
  totalOutputTokens: writable(finiteNumber),
  totalCacheReadTokens: writable(finiteNumber),
  totalCacheWriteTokens: writable(finiteNumber),
  totalReasoningTokens: writable(finiteNumber),
  apiCalls: writable(finiteNumber),
  prLinks: writable(mutableArray(Schema.String)),
  modelBreakdown: writable(
    Schema.Record(Schema.String, Schema.Struct({ calls: writable(finiteNumber), costUSD: writable(finiteNumber) })),
  ),
  turns: writable(mutableArray(sessionDetailTurnSchema)),
})
export type SessionDetail = Schema.Schema.Type<typeof sessionDetailSchema>
