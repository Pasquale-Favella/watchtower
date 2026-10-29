import { useRemoteQuery } from '@/renderer/stores/hooks/use-remote-query'
import { yieldQuery } from '@/renderer/features/optimize/atoms'
import { keyOfScope } from '@/renderer/shared/lib/query-keys'

import type { OverviewScope } from '@/shared/schemas/overview.js'

export function useDeliveryOutcomesStore(scope: OverviewScope) {
  return useRemoteQuery(yieldQuery, scope, keyOfScope)
}
