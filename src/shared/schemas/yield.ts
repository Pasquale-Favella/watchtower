import * as Schema from 'effect/Schema'

const finiteNumber = Schema.Finite
const writable = Schema.mutableKey
const mutableArray = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.mutable(Schema.Array(schema))

export const yieldCategorySchema = Schema.Literals(['productive', 'reverted', 'abandoned', 'ambiguous'])
export type YieldCategory = Schema.Schema.Type<typeof yieldCategorySchema>

export const yieldBucketSchema = Schema.Struct({
  costUSD: writable(finiteNumber),
  sessions: writable(finiteNumber),
  costPercent: writable(finiteNumber),
  sessionPercent: writable(finiteNumber),
})
export type YieldBucket = Schema.Schema.Type<typeof yieldBucketSchema>

export const yieldDetailSchema = Schema.Struct({
  sessionId: writable(Schema.String),
  project: writable(Schema.String),
  costUSD: writable(finiteNumber),
  category: writable(yieldCategorySchema),
  commitCount: writable(finiteNumber),
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
      abandoned: writable(yieldBucketSchema),
      ambiguous: writable(yieldBucketSchema),
      total: writable(Schema.Struct({ costUSD: writable(finiteNumber), sessions: writable(finiteNumber) })),
      productiveToRevertedCostRatio: writable(Schema.NullOr(finiteNumber)),
    }),
  ),
  methodology: writable(Schema.Literal('timestamp-window')),
  details: writable(mutableArray(yieldDetailSchema)),
})
export type YieldPayload = Schema.Schema.Type<typeof yieldPayloadSchema>
