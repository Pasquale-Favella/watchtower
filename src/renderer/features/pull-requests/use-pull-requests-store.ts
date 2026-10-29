import { useRemoteQuery } from '@/renderer/stores/hooks/use-remote-query'
import { useScopeStore } from '@/renderer/stores/hooks/use-scope-store'
import { pullRequestsQuery } from '@/renderer/features/pull-requests/atoms'
import { keyOfScope } from '@/renderer/shared/lib/query-keys'

export function usePullRequestsStore() {
  const { scope, provider, setProvider, detectedProviders } = useScopeStore()
  const query = useRemoteQuery(pullRequestsQuery, scope, keyOfScope)
  return { ...query, provider, setProvider, detectedProviders }
}
