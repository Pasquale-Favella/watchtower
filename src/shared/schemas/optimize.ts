import { z } from 'zod'

export const impactSchema = z.enum(['high', 'medium', 'low'])
export type Impact = z.infer<typeof impactSchema>

export const healthGradeSchema = z.enum(['A', 'B', 'C', 'D', 'F'])
export type HealthGrade = z.infer<typeof healthGradeSchema>

export const trendSchema = z.enum(['active', 'improving'])
export type Trend = z.infer<typeof trendSchema>

export const pasteDestinationSchema = z.enum(['claude-md', 'session-opener', 'prompt', 'shell-config'])
export type PasteDestination = z.infer<typeof pasteDestinationSchema>

export const wasteActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('paste'),
    label: z.string(),
    text: z.string(),
    destination: pasteDestinationSchema.optional(),
  }),
  z.object({
    type: z.literal('command'),
    label: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('file-content'),
    label: z.string(),
    path: z.string(),
    content: z.string(),
  }),
])
export type WasteAction = z.infer<typeof wasteActionSchema>

export const findingIdSchema = z.enum([
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
export type FindingId = z.infer<typeof findingIdSchema>

export const optimizeFindingSchema = z.object({
  id: findingIdSchema,
  title: z.string(),
  explanation: z.string(),
  severity: impactSchema,
  trend: trendSchema.nullable(),
  tokensSaved: z.number(),
  estimatedSavingsUSD: z.number(),
  fix: wasteActionSchema,
})
export type OptimizeFinding = z.infer<typeof optimizeFindingSchema>

export const optimizePayloadSchema = z.object({
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
export type OptimizePayload = z.infer<typeof optimizePayloadSchema>

export const lowWorthCandidateSchema = z.object({
  project: z.string(),
  sessionId: z.string(),
  date: z.string(),
  cost: z.number(),
  tokens: z.number(),
  reasons: z.array(z.string()),
})
export type LowWorthCandidate = z.infer<typeof lowWorthCandidateSchema>

export const contextBloatCandidateSchema = z.object({
  project: z.string(),
  sessionId: z.string(),
  date: z.string(),
  effectiveInputTokens: z.number(),
  outputTokens: z.number(),
  ratio: z.number(),
  excessInputTokens: z.number(),
  growthRatio: z.number().nullable(),
})
export type ContextBloatCandidate = z.infer<typeof contextBloatCandidateSchema>
