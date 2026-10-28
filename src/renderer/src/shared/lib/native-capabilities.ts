import * as Effect from 'effect/Effect'
import { ApplicationClient } from './application-rpc.js'

/** Native shell commands keep their guarded main-process owners. */
export const openExternalAtom = ApplicationClient.runtime.fn((url: string) =>
  Effect.flatMap(ApplicationClient, rpc => rpc('shell:open-external', { url })),
)
