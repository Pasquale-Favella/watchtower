import { useRemoteQuery } from '@/stores/hooks/use-remote-query'
import { useScopeStore } from '@/stores/hooks/use-scope-store'
import { sessionRowsQuery } from '@/features/sessions/atoms'
import { keyOfScope } from '@/shared/lib/query-keys'

export function useSessionsStore() {
  const { scope, provider, setProvider, detectedProviders } = useScopeStore()
  const query = useRemoteQuery(sessionRowsQuery, scope, keyOfScope)
  return { ...query, provider, setProvider, detectedProviders }
}
