import { useRemoteQuery } from '@/app/hooks/use-remote-query'
import { useScopeStore } from '@/app/hooks/use-scope-store'
import { spendQuery } from '@/features/spend/atoms'
import { keyOfScope } from '@/shared/lib/query-keys'

export function useSpendStore() {
  const { scope, provider, setProvider, detectedProviders } = useScopeStore()
  const query = useRemoteQuery(spendQuery, scope, keyOfScope)
  return { ...query, provider, setProvider, detectedProviders }
}
