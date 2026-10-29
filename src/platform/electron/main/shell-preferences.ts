import { readFileSync, writeFileSync } from 'node:fs'

import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

const positionSchema = Schema.Struct({ x: Schema.Finite, y: Schema.Finite })
const defaultBoolean = Schema.Boolean.pipe(
  Schema.withDecodingDefault(Effect.succeed(true)),
  Schema.catchDecoding(() => Effect.succeed(Option.some(true))),
)

/** The persisted shell contract recovers invalid fields independently. */
export const shellPreferencesSchema = Schema.Struct({
  runInBackground: Schema.mutableKey(defaultBoolean),
  orbEnabled: Schema.mutableKey(defaultBoolean),
  orbPosition: Schema.mutableKey(
    Schema.NullOr(positionSchema).pipe(
      Schema.withDecodingDefault(Effect.succeed(null)),
      Schema.catchDecoding(() => Effect.succeed(Option.some(null))),
    ),
  ),
})
export type ShellPreferences = Schema.Schema.Type<typeof shellPreferencesSchema>

export const DEFAULT_SHELL_PREFERENCES: ShellPreferences = {
  runInBackground: true,
  orbEnabled: true,
  orbPosition: null,
}

export class ShellPreferencesError extends Schema.TaggedError<ShellPreferencesError>()('ShellPreferencesError', {
  operation: Schema.Literals(['read', 'decode', 'write']),
  code: Schema.String,
}) {}

function fileError(operation: 'read' | 'write', cause: unknown): ShellPreferencesError {
  const parsed = Schema.decodeUnknownResult(Schema.Struct({ code: Schema.String }))(cause)
  return new ShellPreferencesError({ operation, code: parsed._tag === 'Success' ? parsed.success.code : 'io-failed' })
}

export const loadShellPreferences = Effect.fn('loadShellPreferences')(function* (file: string) {
  const json = yield* Effect.try({ try: () => readFileSync(file, 'utf8'), catch: cause => fileError('read', cause) })
  const preferences = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(shellPreferencesSchema))(json).pipe(
    Effect.mapError(() => new ShellPreferencesError({ operation: 'decode', code: 'invalid-json' })),
  )
  return {
    ...preferences,
    orbPosition: preferences.orbPosition
      ? { x: Math.round(preferences.orbPosition.x), y: Math.round(preferences.orbPosition.y) }
      : null,
  }
})

export const saveShellPreferences = Effect.fn('saveShellPreferences')(function* (
  file: string,
  prefs: ShellPreferences,
) {
  const validated = yield* Schema.decodeUnknownEffect(shellPreferencesSchema)(prefs).pipe(
    Effect.mapError(() => new ShellPreferencesError({ operation: 'decode', code: 'invalid-preferences' })),
  )
  yield* Effect.try({
    try: () => writeFileSync(file, JSON.stringify(validated, null, 2), 'utf8'),
    catch: cause => fileError('write', cause),
  })
})
