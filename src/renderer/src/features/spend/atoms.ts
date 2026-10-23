import * as Effect from 'effect/Effect'
import type * as Atom from 'effect/reactivity/Atom'

import { createRemoteQuerySlot } from '@/app/atoms/remote-query'
import { runtime } from '@/app/renderer-runtime'
import { keyOfScope } from '@/shared/lib/query-keys'
import { RendererApi } from '@/shared/lib/renderer-api'

import type { OverviewScope } from '../../../../shared/schemas/overview.js'

export function createSpendAtoms(factory: Atom.RegistryRuntimeFactory, layer = RendererApi.layer) {
  const remote = factory(layer)
  return {
    spendQuery: createRemoteQuerySlot({
      runtime: remote,
      key: keyOfScope,
      fetch: (scope: OverviewScope) => Effect.flatMap(RendererApi, api => api.getSpend(scope)),
      reactivityKeys: ['ledger', 'pricing'],
    }),
  }
}

export const { spendQuery } = createSpendAtoms(runtime)
