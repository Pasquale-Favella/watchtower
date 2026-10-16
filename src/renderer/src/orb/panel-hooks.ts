import { useEffect } from 'react'

import { useScanStore } from '@/app/stores/scan-store'
import { useSettingsStore } from '@/features/settings/store'
import { orbControls } from '@/shared/lib/api'

import { useOrbPanelStore } from './panel-store'
import { subscribeToOrbPanel } from './panel-wiring'
import { useOrbPlacementStore } from './placement-store'

/** The panel window's bootstrap — the counterpart of `useAppBootstrap`: the
 * data plane, then hydration (scan status, scan activity, placement,
 * currency, its two slices), then telling the main process its data is in —
 * the cue for the first-close peek, so it never opens onto skeletons. It
 * never fires the first scan: the main window owns that. */
export function useOrbPanelBootstrap(): void {
  useEffect(() => {
    const unsubscribe = subscribeToOrbPanel()
    void (async () => {
      await useScanStore.getState().hydrate()
      await Promise.all([
        useOrbPlacementStore.getState().sync(),
        useSettingsStore.getState().loadCurrency(),
        useOrbPanelStore.getState().whenLoaded(),
      ])
      orbControls.panelDataReady()
    })()
    return unsubscribe
  }, [])
}
