import * as Effect from 'effect/Effect'

import { runtime } from '@/app/renderer-runtime'

import { RendererApi } from './renderer-api.js'

/** Native shell commands keep their guarded main-process owners. */
export const openExternalAtom = runtime(RendererApi.layer).fn((url: string) =>
  Effect.flatMap(RendererApi, api => api.openExternal(url)),
)
