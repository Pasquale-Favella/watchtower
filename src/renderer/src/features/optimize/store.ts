import { create } from 'zustand'
import { fetchOptimize, fetchYield } from '@/shared/lib/api'
import { scopedDataSlice, type ScopedDataSlice } from '../../app/stores/data-store'
import { subscribeToRefresh } from '../../app/stores/scan-store'
import type { OptimizePayload } from '../../../../shared/schemas/optimize.js'
import type { YieldPayload } from '../../../../shared/schemas/yield.js'

/** The Optimize section's two payloads — waste findings plus the Reverts/
 * Abandoned `yieldData` for the Yield tab — as one store with two slices
 * (ADR 0011: "useOptimizeStore (waste + yieldData slice)"). The yield
 * slice stays lazy: it is only fetched when the Yield tab mounts, and the
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
  void useOptimizeStore.getState().waste.reload()
  void useOptimizeStore.getState().yieldData.reload()
})
