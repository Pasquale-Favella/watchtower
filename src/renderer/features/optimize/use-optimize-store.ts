import { useRemoteQuery } from '@/renderer/stores/hooks/use-remote-query'
import { useScopeStore } from '@/renderer/stores/hooks/use-scope-store'
import { optimizeQuery } from '@/renderer/features/optimize/atoms'
import { keyOfScope } from '@/renderer/shared/lib/query-keys'

export function useOptimizeStore() {
  const { scope, provider, setProvider, detectedProviders } = useScopeStore()
  const query = useRemoteQuery(optimizeQuery, scope, keyOfScope)
  return { ...query, scope, provider, setProvider, detectedProviders }
}
