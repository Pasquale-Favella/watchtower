import { create } from 'zustand'
import { fetchCompare } from '@/shared/lib/api'
import { keyOfScope, EMPTY_SCOPE, type DataStatus } from '../../app/stores/data-store'
import { subscribeToRefresh } from '../../app/stores/scan-store'
import type { ComparePayload, ComparePair } from '../../../../shared/schemas/compare.js'
import type { OverviewScope } from '../../../../shared/schemas/overview.js'

/** Compare's payload: scope-keyed AND pair-keyed (a pair change is a fresh
 * load, not a SWR refresh). The pair itself stays view-local transient UI —
 * the store only persists it long enough to reload on the refresh tick. */
export interface CompareState {
  data: ComparePayload | null
  error: string | null
  status: DataStatus
  scope: OverviewScope
  pair: ComparePair | undefined
  dataKey: string
  load: (scope: OverviewScope, pair?: ComparePair) => Promise<void>
  reload: () => Promise<void>
  clear: () => void
}

const keyOf = (scope: OverviewScope, pair?: ComparePair): string =>
  pair ? `${keyOfScope(scope)}\u0000${pair.modelA}\u0000${pair.modelB}` : keyOfScope(scope)

export const useCompareStore = create<CompareState>()((set, get) => ({
  data: null,
  error: null,
  status: 'idle',
  scope: EMPTY_SCOPE,
  pair: undefined,
  dataKey: '',
  load: async (scope, pair) => {
    const dataKey = keyOf(scope, pair)
    if (get().dataKey === '' || get().dataKey !== dataKey) {
      set({ data: null, error: null, status: 'loading', scope, pair, dataKey })
    }
    const result = await fetchCompare(scope, pair)
    if (get().dataKey !== dataKey) return
    if (result.ok) set({ data: result.data, error: null, status: 'ready' })
    else set({ error: result.error, status: 'ready' })
  },
  reload: async () => {
    if (get().dataKey === '') return
    await get().load(get().scope, get().pair)
  },
  clear: () => set({ data: null, error: null, status: 'idle', scope: EMPTY_SCOPE, pair: undefined, dataKey: '' }),
}))

subscribeToRefresh(() => { void useCompareStore.getState().reload() })
