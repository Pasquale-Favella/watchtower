import { useRemoteQuery } from '@/renderer/stores/hooks/use-remote-query'
import { useScopeStore } from '@/renderer/stores/hooks/use-scope-store'
import { spendQuery } from '@/renderer/features/spend/atoms'
import { keyOfScope } from '@/renderer/shared/lib/query-keys'

export function useSpendStore() {
  const { scope, provider, setProvider, detectedProviders } = useScopeStore()
  const query = useRemoteQuery(spendQuery, scope, keyOfScope)
  return { ...query, provider, setProvider, detectedProviders }
}
