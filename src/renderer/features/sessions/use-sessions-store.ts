import { useRemoteQuery } from '@/renderer/stores/hooks/use-remote-query'
import { useScopeStore } from '@/renderer/stores/hooks/use-scope-store'
import { sessionRowsQuery } from '@/renderer/features/sessions/atoms'
import { keyOfScope } from '@/renderer/shared/lib/query-keys'

export function useSessionsStore() {
  const { scope, provider, setProvider, detectedProviders } = useScopeStore()
  const query = useRemoteQuery(sessionRowsQuery, scope, keyOfScope)
  return { ...query, provider, setProvider, detectedProviders }
}
