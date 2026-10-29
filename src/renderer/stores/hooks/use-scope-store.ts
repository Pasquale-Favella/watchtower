import { useAtomSet, useAtomValue } from '@effect/atom-react'

import { overviewScopeAtom, setCustomRangeAtom, setPeriodAtom, setProviderAtom } from '@/renderer/stores/atoms/scope.js'
import { useDetectedProviders } from '@/renderer/stores/hooks/use-scan-store.js'

export function useScopeStore() {
  const scope = useAtomValue(overviewScopeAtom)
  const period = scope.period
  const customRange = scope.range ?? null
  const provider = scope.provider ?? 'all'
  const detectedProviders = useDetectedProviders()
  const setPeriod = useAtomSet(setPeriodAtom)
  const setCustomRange = useAtomSet(setCustomRangeAtom)
  const setProvider = useAtomSet(setProviderAtom)

  return { scope, period, customRange, provider, setPeriod, setCustomRange, setProvider, detectedProviders }
}

export function useOverviewScope() {
  return useAtomValue(overviewScopeAtom)
}
