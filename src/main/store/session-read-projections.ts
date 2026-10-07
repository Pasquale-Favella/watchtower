import * as Schema from 'effect/Schema'
import * as SchemaGetter from 'effect/SchemaGetter'

import { modelAliasRowSchema, priceOverrideRowSchema } from '../../shared/schemas/ledger.js'

// Match the canonical ledger codecs' Number coercion for SQLite numeric columns.
export const finiteNumber = Schema.Unknown.pipe(
  Schema.decodeTo(Schema.Number.pipe(Schema.check(Schema.isFinite())), {
    decode: SchemaGetter.transform((value: unknown) => (typeof value === 'symbol' ? Number.NaN : Number(value))),
    encode: SchemaGetter.transform((value: number) => value),
  }),
)
export const nullableString = Schema.NullOr(Schema.String)
export const jsonStringArray = Schema.fromJsonString(Schema.mutable(Schema.Array(Schema.String)))

export const sessionProjectFields = {
  sourceId: finiteNumber,
  sessionId: Schema.String,
  project: nullableString,
  projectPath: nullableString,
  workingDirectory: nullableString,
  canonicalProject: nullableString,
  canonicalCwd: nullableString,
  sourceProvider: Schema.String,
}

/** Narrow session facts used by project and session-list calculations. */
export const sessionSummarySessionSchema = Schema.Struct({
  ...sessionProjectFields,
  title: nullableString,
  repoUrl: nullableString,
})
export type SessionSummarySession = Schema.Schema.Type<typeof sessionSummarySessionSchema>

export const sessionSummaryTurnSchema = Schema.Struct({
  sourceId: finiteNumber,
  sessionId: Schema.String,
  turnIndex: finiteNumber,
  timestamp: Schema.String,
})
export type SessionSummaryTurn = Schema.Schema.Type<typeof sessionSummaryTurnSchema>

/** Billing inputs are kept raw so current aliases/overrides/catalogue price the row at query time. */
export const sessionSummaryCallFields = {
  sourceId: finiteNumber,
  sessionId: Schema.String,
  turnIndex: finiteNumber,
  callIndex: finiteNumber,
  provider: Schema.String,
  model: Schema.String,
  timestamp: Schema.String,
  speed: Schema.Literals(['standard', 'fast']),
  baseCostUSD: finiteNumber,
  savingsUSD: finiteNumber,
  inputTokens: finiteNumber,
  outputTokens: finiteNumber,
  cacheCreationInputTokens: finiteNumber,
  cacheReadInputTokens: finiteNumber,
  cachedInputTokens: finiteNumber,
  webSearchRequests: finiteNumber,
}
export const sessionSummaryCallSchema = Schema.Struct(sessionSummaryCallFields)
export type SessionSummaryCall = Schema.Schema.Type<typeof sessionSummaryCallSchema>

export const sessionSearchSessionSchema = Schema.Struct({
  ...sessionProjectFields,
})
export type SessionSearchSession = Schema.Schema.Type<typeof sessionSearchSessionSchema>

export const sessionSearchTurnSchema = Schema.Struct({
  sourceId: finiteNumber,
  sessionId: Schema.String,
  turnIndex: finiteNumber,
  timestamp: Schema.String,
  userMessage: Schema.String,
})
export type SessionSearchTurn = Schema.Schema.Type<typeof sessionSearchTurnSchema>

export const sessionSearchCallSchema = Schema.Struct({
  sourceId: finiteNumber,
  sessionId: Schema.String,
  turnIndex: finiteNumber,
  callIndex: finiteNumber,
  provider: Schema.String,
  model: Schema.String,
  timestamp: Schema.String,
  bashCommands: jsonStringArray,
})
export type SessionSearchCall = Schema.Schema.Type<typeof sessionSearchCallSchema>

export const sessionSummaryDataSchema = Schema.Struct({
  sessions: Schema.mutable(Schema.Array(sessionSummarySessionSchema)),
  turns: Schema.mutable(Schema.Array(sessionSummaryTurnSchema)),
  calls: Schema.mutable(Schema.Array(sessionSummaryCallSchema)),
  aliases: Schema.mutable(Schema.Array(modelAliasRowSchema)),
  overrides: Schema.mutable(Schema.Array(priceOverrideRowSchema)),
})
export type SessionSummaryData = Schema.Schema.Type<typeof sessionSummaryDataSchema>

export const sessionSearchDataSchema = Schema.Struct({
  sessions: Schema.mutable(Schema.Array(sessionSearchSessionSchema)),
  turns: Schema.mutable(Schema.Array(sessionSearchTurnSchema)),
  calls: Schema.mutable(Schema.Array(sessionSearchCallSchema)),
  aliases: Schema.mutable(Schema.Array(modelAliasRowSchema)),
})
export type SessionSearchData = Schema.Schema.Type<typeof sessionSearchDataSchema>
