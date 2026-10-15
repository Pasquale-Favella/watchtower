import * as Schema from 'effect/Schema'

const finiteNumber = Schema.Number.pipe(Schema.check(Schema.isFinite()))

export const cadenceOptionSchema = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
  ms: Schema.NullOr(finiteNumber),
})
export type CadenceOption = Schema.Schema.Type<typeof cadenceOptionSchema>

/** The persisted refresh-cadence value over `cadence:get`/`cadence:set`
 * (a plain scalar, validated by `isValidCadence` in the main process). */
export const cadenceValueSchema = Schema.String
export type CadenceValue = Schema.Schema.Type<typeof cadenceValueSchema>
