import { useRemoteQuery } from '@/stores/hooks/use-remote-query'
import { useScopeStore } from '@/stores/hooks/use-scope-store'
import { pullRequestsQuery } from '@/features/pull-requests/atoms'
import { keyOfScope } from '@/shared/lib/query-keys'

export function usePullRequestsStore() {
  const { scope, provider, setProvider, detectedProviders } = useScopeStore()
  const query = useRemoteQuery(pullRequestsQuery, scope, keyOfScope)
  return { ...query, provider, setProvider, detectedProviders }
}
