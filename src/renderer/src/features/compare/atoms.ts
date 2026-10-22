import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Atom from 'effect/reactivity/Atom'

import { createRemoteQuerySlot } from '@/app/atoms/remote-query'
import { runtime } from '@/app/renderer-runtime'
import { RendererApi } from '@/shared/lib/renderer-api'

import type { ComparePair, ComparePayload } from '../../../../shared/schemas/compare.js'
import type { OverviewScope } from '../../../../shared/schemas/overview.js'

export interface CompareRequest {
  readonly scope: OverviewScope
  readonly pair?: ComparePair
}

export function pairFromPayload(payload: ComparePayload | null): ComparePair | undefined {
  const report = payload?.report
  return report ? { modelA: report.modelA.model, modelB: report.modelB.model } : undefined
}

export const compareRequestKey = ({ scope, pair }: CompareRequest): string => JSON.stringify([scope, pair ?? null])
export const compareSelectionAtom = Atom.keepAlive(Atom.make<ComparePair | undefined>(undefined))

export function createCompareAtoms(factory: Atom.RegistryRuntimeFactory, layer = RendererApi.layer) {
  return {
    compareQuery: createRemoteQuerySlot({
      runtime: factory(layer),
      key: compareRequestKey,
      fetch: ({ scope, pair }: CompareRequest, previous: Option.Option<ComparePayload | null>) => {
        const committedPair = pair ?? pairFromPayload(Option.getOrNull(previous))
        return Effect.flatMap(RendererApi, api => api.getCompare(scope, committedPair))
      },
      reactivityKeys: ['ledger', 'pricing'],
    }),
  }
}

export const { compareQuery } = createCompareAtoms(runtime)
