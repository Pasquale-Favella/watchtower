import { combine, subscribeToDataPlane, subscribeToSettingsSync } from '@/app/stores/shared-wiring'
import { onOrbPlacement } from '@/shared/lib/api'

import { useOrbPlacementStore } from './placement-store'

/** The panel window's IPC wiring (ADR 0011, amended: one wiring module per
 * window, composed from the shared one): the full data plane — it refetches
 * on the same triggers as the app — settings sync, and the placement it
 * mirrors (open/fold and the peek are the main process's). Feeds store
 * actions; returns the teardown. */
export function subscribeToOrbPanel(): () => void {
  return combine([
    subscribeToDataPlane(),
    subscribeToSettingsSync(),
    onOrbPlacement(placement => useOrbPlacementStore.getState().onPlacement(placement)),
  ])
}
