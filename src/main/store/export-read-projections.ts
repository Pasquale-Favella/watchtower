import * as Schema from 'effect/Schema'

import { modelAliasSchema, priceOverrideSchema } from '../../shared/schemas/ledger.js'
import {
  finiteNumber,
  jsonStringArray,
  nullableString,
  sessionProjectFields,
  sessionSummaryCallFields,
} from './session-read-projections.js'

const exportSessionSchema = Schema.Struct({ ...sessionProjectFields, repoUrl: nullableString })
const exportTurnSchema = Schema.Struct({
  sourceId: finiteNumber,
  sessionId: Schema.String,
  turnIndex: finiteNumber,
  timestamp: Schema.String,
  category: Schema.String,
})
const exportCallSchema = Schema.Struct({
  ...sessionSummaryCallFields,
  reasoningTokens: finiteNumber,
  tools: jsonStringArray,
  mcpTools: jsonStringArray,
  bashCommands: jsonStringArray,
})

/** Decoded facts sufficient for all export tables. */
export const ledgerExportDataSchema = Schema.Struct({
  sessions: Schema.mutable(Schema.Array(exportSessionSchema)),
  turns: Schema.mutable(Schema.Array(exportTurnSchema)),
  calls: Schema.mutable(Schema.Array(exportCallSchema)),
  aliases: Schema.mutable(Schema.Array(modelAliasSchema)),
  overrides: Schema.mutable(Schema.Array(priceOverrideSchema)),
})

export type LedgerExportData = Schema.Schema.Type<typeof ledgerExportDataSchema>
