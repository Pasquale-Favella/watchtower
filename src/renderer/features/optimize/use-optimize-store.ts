import { useRemoteQuery } from '@/stores/hooks/use-remote-query'
import { useScopeStore } from '@/stores/hooks/use-scope-store'
import { optimizeQuery } from '@/features/optimize/atoms'
import { keyOfScope } from '@/shared/lib/query-keys'

export function useOptimizeStore() {
  const { scope, provider, setProvider, detectedProviders } = useScopeStore()
  const query = useRemoteQuery(optimizeQuery, scope, keyOfScope)
  return { ...query, scope, provider, setProvider, detectedProviders }
}
