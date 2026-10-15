import * as Schema from 'effect/Schema'

const finiteNumber = Schema.Finite
const writable = Schema.mutableKey
const mutableArray = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.mutable(Schema.Array(schema))

export const pullRequestCategorySchema = Schema.Struct({
  name: writable(Schema.String),
  cost: writable(finiteNumber),
})

export const pullRequestRowSchema = Schema.Struct({
  url: writable(Schema.String),
  label: writable(Schema.String),
  cost: writable(finiteNumber),
  sessions: writable(finiteNumber),
  calls: writable(finiteNumber),
  firstStarted: writable(Schema.String),
  lastEnded: writable(Schema.String),
  models: writable(mutableArray(Schema.String)),
  /** Per-model raw feeders for Alias-merged models (`models` holds the merged
   * identity). Present only when a merge happened. */
  modelProvenance: writable(Schema.optional(Schema.Record(Schema.String, mutableArray(Schema.String)))),
  categories: writable(Schema.optional(mutableArray(pullRequestCategorySchema))),
})
export type PullRequestRow = Schema.Schema.Type<typeof pullRequestRowSchema>

export const pullRequestsPayloadSchema = Schema.Struct({
  rows: writable(mutableArray(pullRequestRowSchema)),
  distinctCost: writable(finiteNumber),
  distinctSessions: writable(finiteNumber),
  subagentSessions: writable(finiteNumber),
  attributedCost: writable(finiteNumber),
  unattributedCost: writable(finiteNumber),
})
export type PullRequestsPayload = Schema.Schema.Type<typeof pullRequestsPayloadSchema>
