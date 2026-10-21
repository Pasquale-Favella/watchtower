import * as Schema from 'effect/Schema'

const finiteNumber = Schema.Finite
const writable = Schema.mutableKey
const mutableArray = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.mutable(Schema.Array(schema))

export const yieldCategorySchema = Schema.Literals([
  'productive',
  'reverted',
  'mixed',
  'unmatched',
  'unmerged',
  'ambiguous',
  'unknown',
])
export type YieldCategory = Schema.Schema.Type<typeof yieldCategorySchema>

export const yieldBucketSchema = Schema.Struct({
  costUSD: writable(finiteNumber),
  sessions: writable(finiteNumber),
  costPercent: writable(finiteNumber),
  sessionPercent: writable(finiteNumber),
})
export type YieldBucket = Schema.Schema.Type<typeof yieldBucketSchema>

export const yieldDetailSchema = Schema.Struct({
  key: writable(Schema.String),
  sourceId: writable(Schema.NullOr(finiteNumber)),
  sessionId: writable(Schema.String),
  project: writable(Schema.String),
  costUSD: writable(finiteNumber),
  category: writable(yieldCategorySchema),
  commitCount: writable(finiteNumber),
  reasonCode: writable(
    Schema.Literals([
      'main-commits-survive',
      'main-commits-reverted',
      'main-commits-mixed',
      'no-matched-commits',
      'off-main-commits',
      'overlapping-windows',
      'invalid-session-window',
      'inspection-unavailable',
      'membership-unavailable',
    ]),
  ),
  explanation: writable(Schema.String),
  mainRef: writable(Schema.NullOr(Schema.String)),
  window: writable(
    Schema.Struct({ start: writable(Schema.NullOr(Schema.String)), end: writable(Schema.NullOr(Schema.String)) }),
  ),
  inspectionIssues: writable(
    mutableArray(Schema.Struct({ operation: writable(Schema.String), message: writable(Schema.String) })),
  ),
  commits: writable(
    mutableArray(
      Schema.Struct({
        sha: writable(Schema.String),
        timestamp: writable(Schema.String),
        inMain: writable(Schema.NullOr(Schema.Boolean)),
        wasReverted: writable(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  ),
})
export type YieldDetail = Schema.Schema.Type<typeof yieldDetailSchema>

export const yieldPayloadSchema = Schema.Struct({
  period: writable(
    Schema.Struct({ start: writable(Schema.NullOr(Schema.String)), end: writable(Schema.NullOr(Schema.String)) }),
  ),
  summary: writable(
    Schema.Struct({
      productive: writable(yieldBucketSchema),
      reverted: writable(yieldBucketSchema),
      mixed: writable(yieldBucketSchema),
      unmatched: writable(yieldBucketSchema),
      unmerged: writable(yieldBucketSchema),
      ambiguous: writable(yieldBucketSchema),
      unknown: writable(yieldBucketSchema),
      total: writable(Schema.Struct({ costUSD: writable(finiteNumber), sessions: writable(finiteNumber) })),
      productiveToRevertedCostRatio: writable(Schema.NullOr(finiteNumber)),
    }),
  ),
  methodology: writable(Schema.Literal('timestamp-window')),
  costBasis: writable(Schema.Literal('scoped-session-spend')),
  observedAt: writable(Schema.String),
  coverage: writable(
    Schema.Struct({
      totalSessions: writable(finiteNumber),
      inspectedSessions: writable(finiteNumber),
      unknownSessions: writable(finiteNumber),
      matchedSessions: writable(finiteNumber),
    }),
  ),
  attribution: writable(
    Schema.Struct({
      graceMinutes: writable(finiteNumber),
      evidenceStart: writable(Schema.String),
      evidenceEnd: writable(Schema.String),
      historyScope: writable(Schema.Literal('selected-sessions')),
      limitations: writable(mutableArray(Schema.String)),
    }),
  ),
  details: writable(mutableArray(yieldDetailSchema)),
})
export type YieldPayload = Schema.Schema.Type<typeof yieldPayloadSchema>
