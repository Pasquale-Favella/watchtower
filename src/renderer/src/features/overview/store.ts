import { fetchOverview } from '@/shared/lib/api'
import { createScopedDataStore } from '../../app/stores/data-store'
import type { OverviewPayload } from '../../../../shared/schemas/overview.js'

/** Overview's payload, owned by a scope-keyed store that refetches on the
 * shared refresh tick. (map ticket 02) */
export const useOverviewStore = createScopedDataStore<OverviewPayload>(fetchOverview)
