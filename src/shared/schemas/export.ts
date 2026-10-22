import * as Schema from 'effect/Schema'

const writable = Schema.mutableKey

/** A settled export request. The success variant REQUIRES the written path
 * (union, not optional fields) so a pathless `{ ok: true }` fails validation
 * loudly instead of rendering as `Exported to undefined.` in the pane. */
const exportSuccess = Schema.Struct({
  ok: writable(Schema.Literal(true)),
  path: writable(Schema.String),
})
const exportFailure = Schema.Struct({
  ok: writable(Schema.Literal(false)),
  error: writable(Schema.String),
})
const exportCancelled = Schema.Struct({
  ok: writable(Schema.Literal(false)),
  cancelled: writable(Schema.Literal(true)),
})

export const exportResultSchema = Schema.Union([exportSuccess, exportFailure, exportCancelled])
export type ExportResult = Schema.Schema.Type<typeof exportResultSchema>
