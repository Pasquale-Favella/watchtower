import * as Schema from 'effect/Schema'

const writable = Schema.mutableKey
const mutableArray = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => Schema.mutable(Schema.Array(schema))
const optionalText = Schema.optional(Schema.String)

export const coachHarnessRowSchema = Schema.Struct({
  instanceId: writable(Schema.String),
  kind: writable(Schema.String),
  displayName: writable(Schema.String),
  status: writable(Schema.Literals(['pending', 'ready', 'warning', 'error', 'disabled'])),
  auth: writable(
    Schema.Struct({
      status: writable(Schema.Literals(['configured', 'unauthenticated', 'unknown'])),
      label: writable(optionalText),
      loginCommand: writable(optionalText),
    }),
  ),
  version: writable(optionalText),
  binaryPath: writable(optionalText),
  message: writable(optionalText),
})
export type CoachHarnessRow = Schema.Schema.Type<typeof coachHarnessRowSchema>

export const coachHarnessesResultSchema = mutableArray(coachHarnessRowSchema)
export type CoachHarnessesResult = Schema.Schema.Type<typeof coachHarnessesResultSchema>
