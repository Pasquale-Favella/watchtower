import { create } from 'zustand'

import { fetchOrbPanelRequest, fetchOrbPlacement } from '@/shared/lib/api'

import type { OrbPanelRequest, OrbPlacement } from '../../../shared/schemas/orb.js'

/** Whether the orb's panel is open, and on which side of it the orb sits —
 * state the main process owns (it shows, hides and places both windows) and
 * broadcasts to the orb and the panel alike; this store mirrors it. Shared
 * by both orb pages, so it carries no data. (ADR 0011) */
export interface OrbPlacementState {
  placement: OrbPlacement
  onPlacement: (placement: OrbPlacement) => void
  /** Reads the current placement once, at a page's boot. */
  sync: () => Promise<void>
  /** Asks the main process to open the panel (the user's own request, so it
   * takes focus) or to fold it. Peeks are the main process's own. */
  request: (request: OrbPanelRequest) => Promise<void>
}

export const useOrbPlacementStore = create<OrbPlacementState>()(set => ({
  placement: { expanded: false, peek: false, horizontal: 'right', vertical: 'bottom' },
  onPlacement: placement => set({ placement }),
  sync: async () => {
    const result = await fetchOrbPlacement()
    if (result.ok && result.data) set({ placement: result.data })
  },
  request: async intent => {
    const result = await fetchOrbPanelRequest(intent)
    if (result.ok && result.data) set({ placement: result.data })
  },
}))
