import * as Effect from 'effect/Effect'

/** Small renderer adapters for main-owned operating-system and window actions. */
export const getPlatform = Effect.sync(() => window.api?.platform ?? '')

export const openSystemSettings = () =>
  Effect.tryPromise({
    try: () => window.api.openSystemSettings(),
    catch: () => new Error('Unable to open System Settings.'),
  })

export const openExternal = (url: string) =>
  Effect.tryPromise({
    try: () => window.api.openExternal(url),
    catch: () => new Error('Unable to open the external link.'),
  })
