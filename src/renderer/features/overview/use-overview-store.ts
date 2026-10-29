import { useRemoteQuery } from '@/renderer/stores/hooks/use-remote-query'
import { useOverviewScope } from '@/renderer/stores/hooks/use-scope-store'
import { overviewQuery } from '@/renderer/features/overview/atoms'
import { keyOfScope } from '@/renderer/shared/lib/query-keys'

export function useOverviewStore() {
  const scope = useOverviewScope()
  return useRemoteQuery(overviewQuery, scope, keyOfScope)
}
