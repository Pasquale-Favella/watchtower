import * as Schema from 'effect/Schema'

const optionalNumber = Schema.optional(Schema.NullOr(Schema.Number.pipe(Schema.check(Schema.isFinite()))))
const optionalString = Schema.optional(Schema.NullOr(Schema.String))

/** Daily usage facts decoded at the Gateway HTTP boundary. */
export const gatewayReportRowSchema = Schema.Struct({
  day: optionalString,
  model: optionalString,
  total_cost: optionalNumber,
  input_tokens: optionalNumber,
  output_tokens: optionalNumber,
  cached_input_tokens: optionalNumber,
  cache_creation_input_tokens: optionalNumber,
  reasoning_tokens: optionalNumber,
  request_count: optionalNumber,
})
export type GatewayReportRow = Schema.Schema.Type<typeof gatewayReportRowSchema>

export const gatewayReportSchema = Schema.Struct({
  results: Schema.optional(Schema.NullOr(Schema.mutable(Schema.Array(gatewayReportRowSchema)))),
})
