import * as Schema from 'effect/Schema'

const finiteNumber = Schema.Finite
const writable = Schema.mutableKey
const mutableArray = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.mutable(Schema.Array(schema))

export const impactSchema = Schema.Literals(['high', 'medium', 'low'])
export type Impact = Schema.Schema.Type<typeof impactSchema>

export const healthGradeSchema = Schema.Literals(['A', 'B', 'C', 'D', 'F'])
export type HealthGrade = Schema.Schema.Type<typeof healthGradeSchema>

export const trendSchema = Schema.Literals(['active', 'improving'])
export type Trend = Schema.Schema.Type<typeof trendSchema>

export const pasteDestinationSchema = Schema.Literals(['claude-md', 'session-opener', 'prompt', 'shell-config'])
export type PasteDestination = Schema.Schema.Type<typeof pasteDestinationSchema>

export const wasteActionSchema = Schema.Union([
  Schema.Struct({
    type: writable(Schema.Literal('paste')),
    label: writable(Schema.String),
    text: writable(Schema.String),
    destination: writable(Schema.optional(pasteDestinationSchema)),
  }),
  Schema.Struct({
    type: writable(Schema.Literal('command')),
    label: writable(Schema.String),
    text: writable(Schema.String),
  }),
  Schema.Struct({
    type: writable(Schema.Literal('file-content')),
    label: writable(Schema.String),
    path: writable(Schema.String),
    content: writable(Schema.String),
  }),
])
export type WasteAction = Schema.Schema.Type<typeof wasteActionSchema>

export const findingIdSchema = Schema.Literals([
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
export type FindingId = Schema.Schema.Type<typeof findingIdSchema>

export const optimizeFindingSchema = Schema.Struct({
  id: writable(findingIdSchema),
  title: writable(Schema.String),
  explanation: writable(Schema.String),
  severity: writable(impactSchema),
  trend: writable(Schema.NullOr(trendSchema)),
  tokensSaved: writable(finiteNumber),
  estimatedSavingsUSD: writable(finiteNumber),
  fix: writable(wasteActionSchema),
})
export type OptimizeFinding = Schema.Schema.Type<typeof optimizeFindingSchema>

export const optimizePayloadSchema = Schema.Struct({
  period: writable(
    Schema.Struct({ start: writable(Schema.NullOr(Schema.String)), end: writable(Schema.NullOr(Schema.String)) }),
  ),
  summary: writable(
    Schema.Struct({
      healthScore: writable(finiteNumber),
      healthGrade: writable(healthGradeSchema),
      findingCount: writable(finiteNumber),
      periodCostUSD: writable(finiteNumber),
      sessions: writable(finiteNumber),
      calls: writable(finiteNumber),
      potentialSavingsTokens: writable(finiteNumber),
      potentialSavingsCostUSD: writable(finiteNumber),
      potentialSavingsPercent: writable(Schema.NullOr(finiteNumber)),
      costRateUSD: writable(finiteNumber),
    }),
  ),
  findings: writable(mutableArray(optimizeFindingSchema)),
})
export type OptimizePayload = Schema.Schema.Type<typeof optimizePayloadSchema>

export const lowWorthCandidateSchema = Schema.Struct({
  project: writable(Schema.String),
  sessionId: writable(Schema.String),
  date: writable(Schema.String),
  cost: writable(finiteNumber),
  tokens: writable(finiteNumber),
  reasons: writable(mutableArray(Schema.String)),
})
export type LowWorthCandidate = Schema.Schema.Type<typeof lowWorthCandidateSchema>

export const contextBloatCandidateSchema = Schema.Struct({
  project: writable(Schema.String),
  sessionId: writable(Schema.String),
  date: writable(Schema.String),
  effectiveInputTokens: writable(finiteNumber),
  outputTokens: writable(finiteNumber),
  ratio: writable(finiteNumber),
  excessInputTokens: writable(finiteNumber),
  growthRatio: writable(Schema.NullOr(finiteNumber)),
})
export type ContextBloatCandidate = Schema.Schema.Type<typeof contextBloatCandidateSchema>
