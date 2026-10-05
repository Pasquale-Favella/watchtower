import { create } from 'zustand'

import { fetchOverview } from '@/shared/lib/api'

import type { OverviewPayload, OverviewScope } from '../../../shared/schemas/overview.js'
import { type ScopedDataSlice, scopedDataSlice } from '../app/stores/data-store'
import { subscribeToRefresh } from '../app/stores/scan-store'

/** The panel's fixed scopes: it has no scope selector. Today is the headline;
 * the last 30 days feed the Overview's spend chart and economics (and give
 * `spendTrend` the 14 days it needs for a week-over-week delta). */
export const ORB_SCOPES = {
  today: { period: 'today' },
  recent: { period: '30days' },
} as const satisfies Record<string, OverviewScope>

/** The load in flight: concurrent callers share it. */
let inFlight: Promise<void> | null = null

/** The spend panel's store (ADR 0011 shape) — the only orb page that holds
 * ledger data. Two scope-keyed Overview slices on the shared refresh tick:
 * the panel refetches exactly when the app does, on `store:changed` /
 * `config:changed` (ADR 0004), never on a clock of its own. Opening, folding
 * and the first-close peek (its note and timer) are the main process's; the
 * panel only mirrors them through the placement store. */
export interface OrbPanelState {
  today: ScopedDataSlice<OverviewPayload>
  recent: ScopedDataSlice<OverviewPayload>
  load: () => Promise<void>
  /** Resolves once both slices have loaded at least once (no refetch after). */
  whenLoaded: () => Promise<void>
}

export const useOrbPanelStore = create<OrbPanelState>()((set, get) => ({
  today: scopedDataSlice<OverviewPayload>(
    fetchOverview,
    patch => set(state => ({ today: { ...state.today, ...patch } })),
    () => get().today,
  ),
  recent: scopedDataSlice<OverviewPayload>(
    fetchOverview,
    patch => set(state => ({ recent: { ...state.recent, ...patch } })),
    () => get().recent,
  ),
  load: () =>
    (inFlight ??= (async () => {
      try {
        const { today, recent } = get()
        await Promise.all([today.load(ORB_SCOPES.today), recent.load(ORB_SCOPES.recent)])
      } finally {
        inFlight = null
      }
    })()),
  whenLoaded: () => {
    const { today, recent } = get()
    return today.status === 'ready' && recent.status === 'ready' ? Promise.resolve() : get().load()
  },
}))

// Lazy like every slice (ADR 0011): `reload()` no-ops until the first load.
subscribeToRefresh(() => {
  void useOrbPanelStore.getState().today.reload()
  void useOrbPanelStore.getState().recent.reload()
})
