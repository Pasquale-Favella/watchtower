import { useRemoteQuery } from '@/stores/hooks/use-remote-query'
import { yieldQuery } from '@/features/optimize/atoms'
import { keyOfScope } from '@/shared/lib/query-keys'

import type { OverviewScope } from '../../../shared/schemas/overview.js'

export function useDeliveryOutcomesStore(scope: OverviewScope) {
  return useRemoteQuery(yieldQuery, scope, keyOfScope)
}
