import * as Schema from 'effect/Schema'

const writable = Schema.mutableKey

export const updateStatusSchema = Schema.Struct({
  revision: writable(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  currentVersion: writable(Schema.String),
  latestVersion: writable(Schema.NullOr(Schema.String)),
  updateAvailable: writable(Schema.Boolean),
  tag: writable(Schema.NullOr(Schema.String)),
  phase: writable(
    Schema.Literals([
      'idle',
      'unsupported',
      'checking',
      'current',
      'available',
      'downloading',
      'ready',
      'installing',
      'error',
    ]),
  ),
  installSupported: writable(Schema.Boolean),
  progress: writable(
    Schema.NullOr(Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: 0, maximum: 100 }))),
  ),
  message: writable(Schema.NullOr(Schema.String)),
})
export type UpdateStatus = Schema.Schema.Type<typeof updateStatusSchema>

/** The running app's version string over `app:version`. */
export const appVersionSchema = Schema.String
export type AppVersion = Schema.Schema.Type<typeof appVersionSchema>
