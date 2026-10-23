import * as Effect from 'effect/Effect'
import type * as Atom from 'effect/reactivity/Atom'

import { createRemoteQuerySlot } from '@/app/atoms/remote-query'
import { runtime } from '@/app/renderer-runtime'
import { keyOfScope } from '@/shared/lib/query-keys'
import { RendererApi } from '@/shared/lib/renderer-api'

import type { OverviewScope } from '../../../../shared/schemas/overview.js'

export function createOptimizeAtoms(factory: Atom.RegistryRuntimeFactory, layer = RendererApi.layer) {
  const remote = factory(layer)
  return {
    optimizeQuery: createRemoteQuerySlot({
      runtime: remote,
      key: keyOfScope,
      fetch: (scope: OverviewScope) => Effect.flatMap(RendererApi, api => api.getOptimize(scope)),
      reactivityKeys: ['ledger', 'pricing'],
    }),
    yieldQuery: createRemoteQuerySlot({
      runtime: remote,
      key: keyOfScope,
      fetch: (scope: OverviewScope) => Effect.flatMap(RendererApi, api => api.getYield(scope)),
      reactivityKeys: ['ledger', 'pricing'],
    }),
  }
}

export const { optimizeQuery, yieldQuery } = createOptimizeAtoms(runtime)
