import { combine, subscribeToDataPlane, subscribeToSettingsSync } from '@/app/stores/shared-wiring'
import { fetchPendingOrbNotice, onOrbNotice, onOrbPlacement } from '@/shared/lib/api'

import { useOrbPanelStore } from './panel-store'

/** The panel window's IPC wiring (ADR 0011, amended: one wiring module per
 * window, composed from the shared one): the full data plane — it refetches
 * on the same triggers as the app — the placement it mirrors, and the main
 * process's notices. Feeds store actions; returns the teardown. */
export function subscribeToOrbPanel(): () => void {
  const teardown = combine([
    subscribeToDataPlane(),
    subscribeToSettingsSync(),
    onOrbPlacement(placement => useOrbPanelStore.getState().onPlacement(placement)),
    onOrbNotice(notice => useOrbPanelStore.getState().onNotice(notice)),
  ])
  // A notice raised before this page could listen (the first close).
  void fetchPendingOrbNotice().then(result => {
    if (result.ok && result.data) useOrbPanelStore.getState().onNotice(result.data)
  })
  return teardown
}
