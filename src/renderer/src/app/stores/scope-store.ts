import { create } from 'zustand'
import type { DateRange } from '../../../../shared/schemas/renderer.js'
import type { OverviewPeriod, OverviewScope } from '../../../../shared/schemas/overview.js'
import { useSettingsStore } from '../../features/settings/store'

/** Pure UI state — never fetched, never persisted. (ADR 0011) Navigation
 * state left the store in ADR 0014: the router owns route identity; this
 * store owns only the scope selectors every data fetch consumes. */
export interface ScopeState {
  period: OverviewPeriod
  customRange: DateRange | null
  provider: string
  setPeriod: (period: OverviewPeriod) => void
  setCustomRange: (range: DateRange | null) => void
  setProvider: (provider: string) => void
}

/** Derived selector: the `OverviewScope` every data fetch consumes. 'all' is
 * the "no provider filter" sentinel, matching today's AppRoot mapping. */
export const selectScope = (s: ScopeState): OverviewScope => ({
  period: s.period,
  provider: s.provider === 'all' ? undefined : s.provider,
  range: s.customRange ?? undefined,
})

// The active period is initialized from the persisted default, then transient
// (ADR 0011). The settings store's persist middleware rehydrates
// synchronously at module load, so this read is correct before any render.
const initialPeriod = useSettingsStore.getState().defaultPeriod as OverviewPeriod

export const useScopeStore = create<ScopeState>()(set => ({
  period: initialPeriod,
  customRange: null,
  provider: 'all',
  setPeriod: period => set({ period, customRange: null }),
  setCustomRange: customRange => set({ customRange }),
  setProvider: provider => set({ provider }),
}))
