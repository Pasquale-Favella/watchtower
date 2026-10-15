import * as Schema from 'effect/Schema'

const writable = Schema.mutableKey

export const updateStatusSchema = Schema.Struct({
  currentVersion: writable(Schema.String),
  latestVersion: writable(Schema.NullOr(Schema.String)),
  updateAvailable: writable(Schema.Boolean),
  tag: writable(Schema.NullOr(Schema.String)),
})
export type UpdateStatus = Schema.Schema.Type<typeof updateStatusSchema>

/** The running app's version string over `app:version`. */
export const appVersionSchema = Schema.String
export type AppVersion = Schema.Schema.Type<typeof appVersionSchema>
