import { create } from 'zustand'
import type { DateRange, Section } from '../../../../shared/schemas/renderer.js'
import type { OverviewPeriod, OverviewScope } from '../../../../shared/schemas/overview.js'
import { useSettingsStore } from '../../features/settings/store'

/** The canonical section order, shared by nav, shortcuts and the decomposed
 * ContentRegion switch (map ticket 04). */
export const SECTIONS: readonly Section[] = [
  'overview', 'sessions', 'pullRequests', 'spend', 'optimize', 'models', 'compare', 'settings',
]

/** Pure UI state — never fetched, never persisted. (map ticket 02) */
export interface ShellState {
  section: Section
  openSession: string | null
  period: OverviewPeriod
  customRange: DateRange | null
  provider: string
  navigate: (section: Section) => void
  navigateString: (next: string) => void
  setPeriod: (period: OverviewPeriod) => void
  setCustomRange: (range: DateRange | null) => void
  setProvider: (provider: string) => void
  openSessionById: (id: string) => void
  closeSession: () => void
}

/** Derived selector: the `OverviewScope` every data fetch consumes. 'all' is
 * the "no provider filter" sentinel, matching today's AppShell mapping. */
export const selectScope = (s: ShellState): OverviewScope => ({
  period: s.period,
  provider: s.provider === 'all' ? undefined : s.provider,
  range: s.customRange ?? undefined,
})

// The active period is initialized from the persisted default, then transient
// (map ticket 02). The settings store's persist middleware rehydrates
// synchronously at module load, so this read is correct before any render.
const initialPeriod = useSettingsStore.getState().defaultPeriod as OverviewPeriod

export const useShellStore = create<ShellState>()((set) => ({
  section: 'overview',
  openSession: null,
  period: initialPeriod,
  customRange: null,
  provider: 'all',
  navigate: (section) => set({ section, openSession: null }),
  navigateString: (next) => {
    if ((SECTIONS as readonly string[]).includes(next)) {
      set({ section: next as Section, openSession: null })
    }
  },
  setPeriod: (period) => set({ period, customRange: null }),
  setCustomRange: (customRange) => set({ customRange }),
  setProvider: (provider) => set({ provider }),
  openSessionById: (id) => set({ openSession: id }),
  closeSession: () => set({ openSession: null }),
}))
