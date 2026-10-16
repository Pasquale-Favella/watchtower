import * as Schema from 'effect/Schema'

import { overviewScopeSchema } from './overview.js'

const finiteNumber = Schema.Finite
const textList = Schema.mutable(Schema.Array(Schema.String))

export const ledgerMcpScopeResultSchema = Schema.Struct({
  scope: overviewScopeSchema,
  range: Schema.Struct({ startMs: finiteNumber, endMs: finiteNumber }),
  sessions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  calls: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  providers: textList,
})
export type LedgerMcpScopeResult = Schema.Schema.Type<typeof ledgerMcpScopeResultSchema>

export const ledgerMcpCallSchema = Schema.Struct({
  timestamp: Schema.String,
  provider: Schema.String,
  model: Schema.String,
  project: Schema.NullOr(Schema.String),
  working_directory: Schema.NullOr(Schema.String),
  display_cost_usd: finiteNumber,
  savings_usd: finiteNumber,
  estimated: Schema.Boolean,
  tokens: Schema.Struct({
    input: finiteNumber,
    output: finiteNumber,
    cache_read: finiteNumber,
    cache_write: finiteNumber,
    reasoning: finiteNumber,
  }),
  tools: textList,
  skills: textList,
  bash_commands: textList,
  subagents: textList,
})
export type LedgerMcpCall = Schema.Schema.Type<typeof ledgerMcpCallSchema>

export const ledgerMcpCallsSchema = Schema.mutable(Schema.Array(ledgerMcpCallSchema))
