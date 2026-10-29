import * as Effect from 'effect/Effect'
export const getPlatform = Effect.sync(() => window.api?.platform ?? '')
