import { create } from 'zustand'

import { fetchOverview } from '@/shared/lib/api'

import type { OrbNotice, OrbPlacement } from '../../../shared/schemas/orb.js'
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

/** A peek folds itself away after this long unless the pointer rests on it. */
export const PEEK_MS = 6000

/** The load in flight: concurrent callers (bootstrap, a notice) share it. */
let inFlight: Promise<void> | null = null
/** The pending peek fold, if any. */
let peekTimer: ReturnType<typeof setTimeout> | null = null

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
  /** Whether the pointer rests on the panel (it holds a peek open). */
  hovered: boolean
  load: () => Promise<void>
  /** Resolves once both slices have loaded at least once (no refetch after). */
  whenLoaded: () => Promise<void>
  /** The backgrounded notice peeks the panel open — once there is data to
   * show, so it does not open onto skeletons — without taking focus, with
   * its note, and folds it after `PEEK_MS` unless hovered. */
  onNotice: (notice: OrbNotice) => void
  /** The placement the main process broadcast: mirrored for the page, and
   * a fold ends any peek. */
  onPlacement: (placement: OrbPlacement) => void
  setHovered: (hovered: boolean) => void
}

function clearPeekTimer(): void {
  if (peekTimer) clearTimeout(peekTimer)
  peekTimer = null
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
  hovered: false,
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
    if (notice.kind !== 'backgrounded') return
    void get()
      .whenLoaded()
      .then(() => useOrbPlacementStore.getState().request('peek'))
      .then(() => {
        if (!useOrbPlacementStore.getState().placement.expanded) return
        set({ peek: BACKGROUNDED_PEEK })
        if (!get().hovered) schedulePeekFold()
      })
  },
  onPlacement: placement => {
    useOrbPlacementStore.getState().onPlacement(placement)
    if (placement.expanded) return
    clearPeekTimer()
    set({ peek: null })
  },
  setHovered: hovered => {
    set({ hovered })
    clearPeekTimer()
    if (!hovered && get().peek) schedulePeekFold()
  },
}))

function schedulePeekFold(): void {
  clearPeekTimer()
  peekTimer = setTimeout(() => {
    peekTimer = null
    void useOrbPlacementStore.getState().request('fold')
  }, PEEK_MS)
}

// Lazy like every slice (ADR 0011): `reload()` no-ops until the first load.
subscribeToRefresh(() => {
  void useOrbPanelStore.getState().today.reload()
  void useOrbPanelStore.getState().recent.reload()
})
