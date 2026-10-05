import { create } from 'zustand'

import { fetchOverview, fetchSetOrbExpanded } from '@/shared/lib/api'

import type { OrbNotice, OrbPlacement } from '../../../shared/schemas/orb.js'
import type { OverviewPayload, OverviewScope } from '../../../shared/schemas/overview.js'
import { type ScopedDataSlice, scopedDataSlice } from '../app/stores/data-store'
import { subscribeToRefresh } from '../app/stores/scan-store'

/** The orb's fixed scopes: it has no scope selector. Today is the headline;
 * the last 30 days feed the Overview's spend chart and economics (and give
 * `spendTrend` the 14 days it needs for a week-over-week delta). */
export const ORB_SCOPES = {
  today: { period: 'today' },
  recent: { period: '30days' },
} as const satisfies Record<string, OverviewScope>

/** Data younger than this is not refetched just because the panel opened. */
export const ORB_FRESH_MS = 60 * 1000

export const BACKGROUNDED_PEEK = 'Still watching in the background'

/** The load in flight: concurrent callers (bootstrap, a notice) share it. */
let inFlight: Promise<void> | null = null

/** The background orb's store (ADR 0011 shape): two scope-keyed Overview
 * slices on the shared refresh tick — so a scan or config change repaints the
 * orb the same way it repaints the Overview — plus the orb's window UI state.
 * Window placement is owned by the main process; this store mirrors it. */
export interface OrbState {
  today: ScopedDataSlice<OverviewPayload>
  recent: ScopedDataSlice<OverviewPayload>
  /** When the slices last finished loading (ms epoch); 0 = never. */
  loadedAt: number
  placement: OrbPlacement
  /** A transient note shown while the panel peeks open on its own (after the
   * window was closed to the tray). */
  peek: string | null
  load: () => Promise<void>
  /** Resolves once the slices have loaded at least once (no refetch after). */
  whenLoaded: () => Promise<void>
  /** Unfolds/folds the panel. Unfolding refetches stale data. */
  setExpanded: (expanded: boolean) => Promise<void>
  onPlacement: (placement: OrbPlacement) => void
  onNotice: (notice: OrbNotice) => void
}

export const useOrbStore = create<OrbState>()((set, get) => ({
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
  loadedAt: 0,
  placement: { expanded: false, horizontal: 'right', vertical: 'bottom' },
  peek: null,
  load: () =>
    (inFlight ??= (async () => {
      try {
        const { today, recent } = get()
        await Promise.all([today.load(ORB_SCOPES.today), recent.load(ORB_SCOPES.recent)])
        set({ loadedAt: Date.now() })
      } finally {
        inFlight = null
      }
    })()),
  whenLoaded: () => (get().loadedAt ? Promise.resolve() : get().load()),
  setExpanded: async expanded => {
    if (expanded && Date.now() - get().loadedAt > ORB_FRESH_MS) void get().load()
    set({ peek: null })
    const result = await fetchSetOrbExpanded(expanded)
    if (result.ok && result.data) set({ placement: result.data })
  },
  onPlacement: placement => set(placement.expanded ? { placement } : { placement, peek: null }),
  onNotice: notice => {
    // Both notices unfold the panel — but only once there is data to show, so
    // it never opens onto skeletons. Only the backgrounded one explains itself.
    void get()
      .whenLoaded()
      .then(() => get().setExpanded(true))
      .then(() => {
        if (notice.kind === 'backgrounded') set({ peek: BACKGROUNDED_PEEK })
      })
  },
}))

// Lazy like every slice (ADR 0011): nothing refetches until the orb loaded once.
subscribeToRefresh(() => {
  const { today, recent, loadedAt } = useOrbStore.getState()
  if (!loadedAt) return
  void Promise.all([today.reload(), recent.reload()]).then(() => useOrbStore.setState({ loadedAt: Date.now() }))
})
