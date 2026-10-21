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
  'low-cache-reuse',
  'tool-failures',
  'interrupted-calls',
])
export type FindingId = Schema.Schema.Type<typeof findingIdSchema>

export const findingClassSchema = Schema.Literals(['setup', 'habit', 'information'])
export const findingBasisSchema = Schema.Literals(['observed', 'modeled'])
export const findingQuantitySchema = Schema.Struct({
  value: writable(finiteNumber),
  unit: writable(Schema.Literals(['reads', 'tokens', 'sessions', 'calls', 'turns', 'definitions', 'ratio', 'tools'])),
})
export const findingSessionSchema = Schema.Struct({
  key: writable(Schema.String),
  sourceId: writable(Schema.NullOr(finiteNumber)),
  sessionId: writable(Schema.String),
  project: writable(Schema.String),
  costUSD: writable(finiteNumber),
  reasons: writable(mutableArray(Schema.String)),
})

export const optimizeFindingSchema = Schema.Struct({
  id: writable(findingIdSchema),
  title: writable(Schema.String),
  explanation: writable(Schema.String),
  severity: writable(impactSchema),
  trend: writable(Schema.NullOr(trendSchema)),
  findingClass: writable(findingClassSchema),
  basis: writable(findingBasisSchema),
  quantity: writable(findingQuantitySchema),
  assumptions: writable(mutableArray(Schema.String)),
  affectedSessions: writable(mutableArray(findingSessionSchema)),
  associatedSpendUSD: writable(Schema.NullOr(finiteNumber)),
  tokensSaved: writable(Schema.NullOr(finiteNumber)),
  estimatedSavingsUSD: writable(Schema.NullOr(finiteNumber)),
  fix: writable(wasteActionSchema),
})
export type OptimizeFinding = Schema.Schema.Type<typeof optimizeFindingSchema>

export const optimizePayloadSchema = Schema.Struct({
  period: writable(
    Schema.Struct({ start: writable(Schema.NullOr(Schema.String)), end: writable(Schema.NullOr(Schema.String)) }),
  ),
  summary: writable(
    Schema.Struct({
      healthScore: writable(Schema.NullOr(finiteNumber)),
      healthGrade: writable(Schema.NullOr(healthGradeSchema)),
      findingCount: writable(finiteNumber),
      periodCostUSD: writable(finiteNumber),
      sessions: writable(finiteNumber),
      calls: writable(finiteNumber),
      potentialSavingsTokens: writable(Schema.NullOr(finiteNumber)),
      potentialSavingsCostUSD: writable(Schema.NullOr(finiteNumber)),
      potentialSavingsPercent: writable(Schema.NullOr(finiteNumber)),
      setupCoverage: writable(
        Schema.Struct({
          eligibleSessions: writable(finiteNumber),
          observedSessions: writable(finiteNumber),
        }),
      ),
      behaviorSessions: writable(finiteNumber),
      excludedSidechainSessions: writable(finiteNumber),
    }),
  ),
  findings: writable(mutableArray(optimizeFindingSchema)),
})
export type OptimizePayload = Schema.Schema.Type<typeof optimizePayloadSchema>

export const lowWorthCandidateSchema = Schema.Struct({
  key: writable(Schema.optional(Schema.String)),
  project: writable(Schema.String),
  sessionId: writable(Schema.String),
  date: writable(Schema.String),
  cost: writable(finiteNumber),
  tokens: writable(finiteNumber),
  reasons: writable(mutableArray(Schema.String)),
})
export type LowWorthCandidate = Schema.Schema.Type<typeof lowWorthCandidateSchema>

export const contextBloatCandidateSchema = Schema.Struct({
  key: writable(Schema.optional(Schema.String)),
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
