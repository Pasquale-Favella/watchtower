import * as Schema from 'effect/Schema'

const writable = Schema.mutableKey

export const exportResultSchema = Schema.Struct({
  ok: writable(Schema.Boolean),
  path: writable(Schema.optional(Schema.String)),
  error: writable(Schema.optional(Schema.String)),
})
export type ExportResult = Schema.Schema.Type<typeof exportResultSchema>
