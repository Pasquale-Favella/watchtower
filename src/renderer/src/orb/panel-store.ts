import { create } from 'zustand'

import { fetchOverview } from '@/shared/lib/api'

import type { OrbNotice } from '../../../shared/schemas/orb.js'
import type { OverviewPayload, OverviewScope } from '../../../shared/schemas/overview.js'
import { type ScopedDataSlice, scopedDataSlice } from '../app/stores/data-store'
import { subscribeToRefresh } from '../app/stores/scan-store'
import { useOrbPlacementStore } from './placement-store'

/** The panel's fixed scopes: it has no scope selector. Today is the headline;
 * the last 30 days feed the Overview's spend chart and economics (and give
 * `spendTrend` the 14 days it needs for a week-over-week delta). */
export const ORB_SCOPES = {
  today: { period: 'today' },
  recent: { period: '30days' },
} as const satisfies Record<string, OverviewScope>

export const BACKGROUNDED_PEEK = 'Still watching in the background'

/** The load in flight: concurrent callers (bootstrap, a notice) share it. */
let inFlight: Promise<void> | null = null

/** The spend panel's store (ADR 0011 shape) — the only orb page that holds
 * ledger data. Two scope-keyed Overview slices on the shared refresh tick:
 * the panel refetches exactly when the app does, on `store:changed` /
 * `config:changed` (ADR 0004), never on a clock of its own. */
export interface OrbPanelState {
  today: ScopedDataSlice<OverviewPayload>
  recent: ScopedDataSlice<OverviewPayload>
  /** A transient note shown while the panel peeks open on its own (after the
   * first close to the tray). */
  peek: string | null
  load: () => Promise<void>
  /** Resolves once both slices have loaded at least once (no refetch after). */
  whenLoaded: () => Promise<void>
  /** Both notices open the panel — once there is data to show, so it never
   * opens onto skeletons. A summon opens it focused; the backgrounded peek
   * opens it inactive, with its note. */
  onNotice: (notice: OrbNotice) => void
  clearPeek: () => void
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
  peek: null,
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
  onNotice: notice => {
    const summoned = notice.kind === 'summoned'
    void get()
      .whenLoaded()
      .then(() => useOrbPlacementStore.getState().setExpanded(true, summoned))
      .then(() => set({ peek: summoned ? null : BACKGROUNDED_PEEK }))
  },
  clearPeek: () => set({ peek: null }),
}))

// Lazy like every slice (ADR 0011): `reload()` no-ops until the first load.
subscribeToRefresh(() => {
  void useOrbPanelStore.getState().today.reload()
  void useOrbPanelStore.getState().recent.reload()
})
