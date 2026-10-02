import { z } from 'zod'

// Frozen copies of the pre-Effect leaf view contracts. Delete once the final
// Watchtower-owned Zod contracts and dependency are removed.
const spendSegmentSchema = z.object({
  name: z.string(),
  cost: z.number(),
  sourceModels: z.array(z.string()).optional(),
})
const spendDayEntrySchema = z.object({ date: z.string(), cost: z.number(), segments: z.array(spendSegmentSchema) })
const spendFlowNodeSchema = z.object({
  id: z.string(),
  label: z.string(),
  cost: z.number(),
  sourceModels: z.array(z.string()).optional(),
})
const spendFlowLinkSchema = z.object({ model: z.string(), project: z.string(), cost: z.number() })
const spendFlowSchema = z.object({
  models: z.array(spendFlowNodeSchema),
  projects: z.array(spendFlowNodeSchema),
  links: z.array(spendFlowLinkSchema),
})
const spendPayloadSchema = z.object({
  byModel: z.array(spendDayEntrySchema),
  byProject: z.array(spendDayEntrySchema),
  flow: spendFlowSchema,
  dataStart: z.string().nullable(),
})

const compareFormatFnSchema = z.enum(['cost', 'number', 'percent', 'decimal', 'compact'])
const compareModelStatSchema = z.object({
  model: z.string(),
  displayName: z.string(),
  calls: z.number(),
  costUSD: z.number(),
  outputTokens: z.number(),
  inputTokens: z.number(),
  cacheReadTokens: z.number(),
  totalTurns: z.number(),
  editTurns: z.number(),
  oneShotTurns: z.number(),
  retries: z.number(),
})
const compareWinnerSchema = z.enum(['a', 'b', 'tie', 'none'])
const comparisonRowSchema = z.object({
  label: z.string(),
  valueA: z.number().nullable(),
  valueB: z.number().nullable(),
  formatFn: compareFormatFnSchema,
  winner: compareWinnerSchema,
})
const categoryComparisonSchema = z.object({
  category: z.string(),
  turnsA: z.number(),
  editTurnsA: z.number(),
  oneShotRateA: z.number().nullable(),
  turnsB: z.number(),
  editTurnsB: z.number(),
  oneShotRateB: z.number().nullable(),
  winner: compareWinnerSchema,
})
const workingStyleRowSchema = z.object({
  label: z.string(),
  valueA: z.number().nullable(),
  valueB: z.number().nullable(),
  formatFn: compareFormatFnSchema,
})
const compareReportSchema = z.object({
  modelA: compareModelStatSchema,
  modelB: compareModelStatSchema,
  metrics: z.array(comparisonRowSchema),
  categories: z.array(categoryComparisonSchema),
  workingStyle: z.array(workingStyleRowSchema),
})
const comparePayloadSchema = z.object({
  models: z.array(compareModelStatSchema),
  report: compareReportSchema.nullable(),
})
const comparePairSchema = z.object({ modelA: z.string(), modelB: z.string() })

const impactSchema = z.enum(['high', 'medium', 'low'])
const healthGradeSchema = z.enum(['A', 'B', 'C', 'D', 'F'])
const trendSchema = z.enum(['active', 'improving'])
const pasteDestinationSchema = z.enum(['claude-md', 'session-opener', 'prompt', 'shell-config'])
const wasteActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('paste'),
    label: z.string(),
    text: z.string(),
    destination: pasteDestinationSchema.optional(),
  }),
  z.object({ type: z.literal('command'), label: z.string(), text: z.string() }),
  z.object({ type: z.literal('file-content'), label: z.string(), path: z.string(), content: z.string() }),
])
const findingIdSchema = z.enum([
  'read-edit-ratio',
  'build-folder-reads',
  'redundant-rereads',
  'warmup-heavy',
  'mcp-low-coverage',
  'mcp-project-scope',
  'mcp-deferral-off',
  'mcp-alwaysload-hygiene',
  'mcp-defer-threshold',
  'retry-heavy-capabilities',
  'low-worth-sessions',
  'context-heavy-sessions',
  'cost-outliers',
  'unused-agents',
  'unused-skills',
  'unused-commands',
])
const optimizeFindingSchema = z.object({
  id: findingIdSchema,
  title: z.string(),
  explanation: z.string(),
  severity: impactSchema,
  trend: trendSchema.nullable(),
  tokensSaved: z.number(),
  estimatedSavingsUSD: z.number(),
  fix: wasteActionSchema,
})
const optimizePayloadSchema = z.object({
  period: z.object({ start: z.string().nullable(), end: z.string().nullable() }),
  summary: z.object({
    healthScore: z.number(),
    healthGrade: healthGradeSchema,
    findingCount: z.number(),
    periodCostUSD: z.number(),
    sessions: z.number(),
    calls: z.number(),
    potentialSavingsTokens: z.number(),
    potentialSavingsCostUSD: z.number(),
    potentialSavingsPercent: z.number().nullable(),
    costRateUSD: z.number(),
  }),
  findings: z.array(optimizeFindingSchema),
})
const lowWorthCandidateSchema = z.object({
  project: z.string(),
  sessionId: z.string(),
  date: z.string(),
  cost: z.number(),
  tokens: z.number(),
  reasons: z.array(z.string()),
})
const contextBloatCandidateSchema = z.object({
  project: z.string(),
  sessionId: z.string(),
  date: z.string(),
  effectiveInputTokens: z.number(),
  outputTokens: z.number(),
  ratio: z.number(),
  excessInputTokens: z.number(),
  growthRatio: z.number().nullable(),
})

const yieldCategorySchema = z.enum(['productive', 'reverted', 'abandoned', 'ambiguous'])
const yieldBucketSchema = z.object({
  costUSD: z.number(),
  sessions: z.number(),
  costPercent: z.number(),
  sessionPercent: z.number(),
})
const yieldDetailSchema = z.object({
  sessionId: z.string(),
  project: z.string(),
  costUSD: z.number(),
  category: yieldCategorySchema,
  commitCount: z.number(),
})
const yieldPayloadSchema = z.object({
  period: z.object({ start: z.string().nullable(), end: z.string().nullable() }),
  summary: z.object({
    productive: yieldBucketSchema,
    reverted: yieldBucketSchema,
    abandoned: yieldBucketSchema,
    ambiguous: yieldBucketSchema,
    total: z.object({ costUSD: z.number(), sessions: z.number() }),
    productiveToRevertedCostRatio: z.number().nullable(),
  }),
  methodology: z.literal('timestamp-window'),
  details: z.array(yieldDetailSchema),
})

export const preEffectLeafViewContracts = {
  spendSegmentSchema,
  spendDayEntrySchema,
  spendFlowNodeSchema,
  spendFlowLinkSchema,
  spendFlowSchema,
  spendPayloadSchema,
  compareFormatFnSchema,
  compareModelStatSchema,
  compareWinnerSchema,
  comparisonRowSchema,
  categoryComparisonSchema,
  workingStyleRowSchema,
  compareReportSchema,
  comparePayloadSchema,
  comparePairSchema,
  impactSchema,
  healthGradeSchema,
  trendSchema,
  pasteDestinationSchema,
  wasteActionSchema,
  findingIdSchema,
  optimizeFindingSchema,
  optimizePayloadSchema,
  lowWorthCandidateSchema,
  contextBloatCandidateSchema,
  yieldCategorySchema,
  yieldBucketSchema,
  yieldDetailSchema,
  yieldPayloadSchema,
}
