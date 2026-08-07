import { fetchSpend } from '@/shared/lib/api'
import { createScopedDataStore } from '../../app/stores/data-store'
import type { SpendPayload } from '../../../../shared/schemas/spend.js'

/** Spend payload, scope-keyed and refresh-tick subscribed. (map ticket 02) */
export const useSpendStore = createScopedDataStore<SpendPayload>(fetchSpend)
