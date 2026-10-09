import * as Schema from 'effect/Schema'

import { modelAliasSchema, priceOverrideSchema } from '../../shared/schemas/ledger.js'
import { finiteNumber, jsonStringArray, nullableString } from './session-read-projections.js'

const toolSequence = Schema.fromJsonString(
  Schema.mutable(
    Schema.Array(
      Schema.mutable(
        Schema.Array(
          Schema.Struct({
            tool: Schema.String,
            file: Schema.optional(Schema.String),
          }),
        ),
      ),
    ),
  ),
)

export const overviewReadSessionSchema = Schema.Struct({
  sourceId: finiteNumber,
  sessionId: Schema.String,
  sourceProvider: nullableString,
})

export const overviewReadTurnSchema = Schema.Struct({
  sourceId: finiteNumber,
  sessionId: Schema.String,
  turnIndex: finiteNumber,
  timestamp: Schema.String,
  userMessage: Schema.String,
  category: Schema.String,
  subCategory: nullableString,
  retries: finiteNumber,
  hasEdits: finiteNumber,
})

export const overviewReadCallSchema = Schema.Struct({
  sourceId: finiteNumber,
  sessionId: Schema.String,
  turnIndex: finiteNumber,
  callIndex: finiteNumber,
  provider: Schema.String,
  model: Schema.String,
  timestamp: Schema.String,
  speed: Schema.Literals(['standard', 'fast']),
  baseCostUSD: finiteNumber,
  isEstimated: finiteNumber,
  savingsUSD: finiteNumber,
  savingsBaselineModel: nullableString,
  inputTokens: finiteNumber,
  outputTokens: finiteNumber,
  cacheCreationInputTokens: finiteNumber,
  cacheReadInputTokens: finiteNumber,
  cachedInputTokens: finiteNumber,
  webSearchRequests: finiteNumber,
  tools: jsonStringArray,
  mcpTools: jsonStringArray,
  subagentTypes: jsonStringArray,
  toolSequence,
})

/** Minimal decoded facts needed by Overview; transcript and unrelated billing columns are omitted. */
export const overviewReadDataSchema = Schema.Struct({
  sessions: Schema.mutable(Schema.Array(overviewReadSessionSchema)),
  turns: Schema.mutable(Schema.Array(overviewReadTurnSchema)),
  calls: Schema.mutable(Schema.Array(overviewReadCallSchema)),
  aliases: Schema.mutable(Schema.Array(modelAliasSchema)),
  overrides: Schema.mutable(Schema.Array(priceOverrideSchema)),
})

export type OverviewReadSession = Schema.Schema.Type<typeof overviewReadSessionSchema>
export type OverviewReadTurn = Schema.Schema.Type<typeof overviewReadTurnSchema>
export type OverviewReadCall = Schema.Schema.Type<typeof overviewReadCallSchema>
export type OverviewReadData = Schema.Schema.Type<typeof overviewReadDataSchema>
