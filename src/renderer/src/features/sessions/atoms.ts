import * as Effect from 'effect/Effect'
import type * as Atom from 'effect/reactivity/Atom'

import { createRemoteQuerySlot } from '@/app/atoms/remote-query'
import { runtime } from '@/app/renderer-runtime'
import { keyOfScope } from '@/shared/lib/query-keys'
import { type SessionRequest, sessionRequestKey } from '@/shared/lib/query-keys'
import { RendererApi } from '@/shared/lib/renderer-api'

import type { OverviewScope } from '../../../../shared/schemas/overview.js'

export function createSessionsAtoms(factory: Atom.RegistryRuntimeFactory, layer = RendererApi.layer) {
  const remote = factory(layer)
  return {
    sessionQuery: createRemoteQuerySlot({
      runtime: remote,
      key: sessionRequestKey,
      fetch: ({ sessionId, sourceId }: SessionRequest) =>
        Effect.flatMap(RendererApi, api => api.getSession(sessionId, sourceId)),
    }),
    sessionRowsQuery: createRemoteQuerySlot({
      runtime: remote,
      key: keyOfScope,
      fetch: (scope: OverviewScope) => Effect.flatMap(RendererApi, api => api.getSessionRows(scope)),
      reactivityKeys: ['ledger', 'pricing'],
    }),
  }
}

export const { sessionRowsQuery, sessionQuery } = createSessionsAtoms(runtime)
