import { create } from 'zustand'

import { fetchOptimize, fetchYield } from '@/shared/lib/api'

import type { OptimizePayload } from '../../../../shared/schemas/optimize.js'
import type { YieldPayload } from '../../../../shared/schemas/yield.js'
import { type ScopedDataSlice, scopedDataSlice } from '../../app/stores/data-store'
import { subscribeToRefresh } from '../../app/stores/scan-store'

/** The Optimize section's findings and delivery evidence as two slices
 * (ADR 0011: "useOptimizeStore (waste + yieldData slice)"). The yield
 * slice stays lazy: it is only fetched when Outcomes or Reverts mounts, and the
 * shared tick's reload() no-ops until then. */
export interface OptimizeState {
  waste: ScopedDataSlice<OptimizePayload>
  yieldData: ScopedDataSlice<YieldPayload>
}

export const useOptimizeStore = create<OptimizeState>()((set, get) => ({
  waste: scopedDataSlice<OptimizePayload>(
    fetchOptimize,
    patch => set(state => ({ waste: { ...state.waste, ...patch } })),
    () => get().waste,
  ),
  yieldData: scopedDataSlice<YieldPayload>(
    fetchYield,
    patch => set(state => ({ yieldData: { ...state.yieldData, ...patch } })),
    () => get().yieldData,
  ),
}))

subscribeToRefresh(() => {
  const { waste, yieldData } = useOptimizeStore.getState()
  void waste.reload()
  void yieldData.reload()
})
