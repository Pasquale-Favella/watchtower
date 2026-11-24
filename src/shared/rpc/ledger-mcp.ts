import * as Schema from 'effect/Schema'

import { overviewScopeSchema } from '@/shared/schemas/overview.js'

// JSON has no undefined value. Exact optional keys keep the advertised MCP
// JSON Schema aligned with its decoder.
const scopeInputSchema = overviewScopeSchema.mapFields(fields => ({
  ...fields,
  provider: Schema.optionalKey(Schema.required(Schema.readonlyKey(fields.provider))),
  range: Schema.optionalKey(Schema.required(Schema.readonlyKey(fields.range))),
}))

export const ledgerMcpScopedToolInputSchema = Schema.Struct({ scope: Schema.optionalKey(scopeInputSchema) })

export const ledgerMcpCallsToolInputSchema = Schema.Struct({
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200))),
  scope: Schema.optionalKey(scopeInputSchema),
  model: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  category: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.String),
})

export const ledgerMcpCallsRequestSchema = ledgerMcpCallsToolInputSchema.mapFields(fields => ({
  ...fields,
  scope: overviewScopeSchema,
}))
