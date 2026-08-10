import { fetchSpend } from '@/shared/lib/api'
import { createScopedDataStore } from '../../app/stores/data-store'
import type { SpendPayload } from '../../../../shared/schemas/spend.js'

/** Spend payload, scope-keyed and refresh-tick subscribed. (ADR 0011) */
export const useSpendStore = createScopedDataStore<SpendPayload>(fetchSpend)
