import * as Schema from 'effect/Schema'

import { modelAliasSchema, priceOverrideSchema } from '../../shared/schemas/ledger.js'
import {
  finiteNumber,
  jsonStringArray,
  nullableString,
  sessionProjectFields,
  sessionSummaryCallFields,
} from './session-read-projections.js'

const ledgerViewSessionSchema = Schema.Struct(sessionProjectFields)

const ledgerViewTurnSchema = Schema.Struct({
  sourceId: finiteNumber,
  sessionId: Schema.String,
  turnIndex: finiteNumber,
  timestamp: Schema.String,
  category: Schema.String,
  subCategory: nullableString,
})

const ledgerViewCallSchema = Schema.Struct({
  ...sessionSummaryCallFields,
  isEstimated: finiteNumber,
  reasoningTokens: finiteNumber,
  subagentTypes: jsonStringArray,
})

/** Decoded facts required by dashboard and analytics calculations. */
export const ledgerViewDataSchema = Schema.Struct({
  sessions: Schema.mutable(Schema.Array(ledgerViewSessionSchema)),
  turns: Schema.mutable(Schema.Array(ledgerViewTurnSchema)),
  calls: Schema.mutable(Schema.Array(ledgerViewCallSchema)),
  aliases: Schema.mutable(Schema.Array(modelAliasSchema)),
  overrides: Schema.mutable(Schema.Array(priceOverrideSchema)),
})

export type LedgerViewData = Schema.Schema.Type<typeof ledgerViewDataSchema>
