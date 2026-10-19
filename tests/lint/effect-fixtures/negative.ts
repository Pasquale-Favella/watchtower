import { Effect } from 'effect'
import { it } from 'vitest'

Effect.succeed(1)

it('does not run an Effect value', () => Effect.succeed(1))
