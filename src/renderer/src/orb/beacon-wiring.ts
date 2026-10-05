import { useScanStore } from '@/app/stores/scan-store'
import { combine, subscribeToScanLifecycle, subscribeToSettingsSync } from '@/app/stores/shared-wiring'
import { onOrbPlacement } from '@/shared/lib/api'

import { useOrbPlacementStore } from './placement-store'

/** The orb window's IPC wiring (ADR 0011, amended: one wiring module per
 * window, composed from the shared one). Deliberately light: the orb shows
 * only the scan state and where it sits — it holds no ledger data, so a
 * finished scan just ends the spinner. Feeds store actions; returns the
 * teardown. */
export function subscribeToOrbBeacon(): () => void {
  return combine([
    subscribeToScanLifecycle(() => useScanStore.getState().onIdle()),
    subscribeToSettingsSync(),
    onOrbPlacement(placement => useOrbPlacementStore.getState().onPlacement(placement)),
  ])
}
