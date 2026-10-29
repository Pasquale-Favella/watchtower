import { useRemoteQuery } from '@/stores/hooks/use-remote-query'
import { useOverviewScope } from '@/stores/hooks/use-scope-store'
import { overviewQuery } from '@/features/overview/atoms'
import { keyOfScope } from '@/shared/lib/query-keys'

export function useOverviewStore() {
  const scope = useOverviewScope()
  return useRemoteQuery(overviewQuery, scope, keyOfScope)
}
