import { Effect } from 'effect'
import { it } from '@effect/vitest'

export const retained = Effect.succeed(1)

it.effect('runs an Effect value', () => Effect.succeed(1))
