import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import * as Option from 'effect/Option'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import { useContext, useEffect, useMemo } from 'react'

import { useRemoteQuery } from '@/renderer/stores/hooks/use-remote-query'
import { useScopeStore } from '@/renderer/stores/hooks/use-scope-store'
import {
  compareQuery,
  compareRequestKey,
  compareSelectionAtom,
  pairFromPayload,
} from '@/renderer/features/compare/atoms'

import type { ComparePair } from '@/shared/schemas/compare.js'

export function useCompareStore() {
  const { scope, provider, setProvider, detectedProviders } = useScopeStore()
  const registry = useContext(RegistryContext)
  const selectedPair = useAtomValue(compareSelectionAtom)
  const selectPair = useAtomSet(compareSelectionAtom)
  const request = useMemo(() => {
    const previous = Option.getOrNull(AsyncResult.value(registry.get(compareQuery.resultAtom)))
    return { scope, pair: selectedPair ?? pairFromPayload(previous) }
  }, [scope, selectedPair, registry])
  const { data: payload, error, status } = useRemoteQuery(compareQuery, request, compareRequestKey)
  const pair = request.pair ?? pairFromPayload(payload)

  useEffect(() => {
    const models = payload?.models
    if (!models) return
    const available = new Set(models.map(model => model.model))
    const nextA = pair?.modelA && available.has(pair.modelA) ? pair.modelA : (models[0]?.model ?? null)
    const nextB = pair?.modelB && available.has(pair.modelB) ? pair.modelB : (models[1]?.model ?? null)
    if (nextA && nextB && (nextA !== pair?.modelA || nextB !== pair?.modelB)) {
      selectPair({ modelA: nextA, modelB: nextB } satisfies ComparePair)
    }
  }, [payload, pair?.modelA, pair?.modelB, selectPair])

  return { payload, error, status, pair, selectPair, provider, setProvider, detectedProviders }
}
