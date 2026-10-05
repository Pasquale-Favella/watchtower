import { useEffect } from 'react'

import { useScanStore } from '@/app/stores/scan-store'
import { useSettingsStore } from '@/features/settings/store'
import { fetchScanStatus } from '@/shared/lib/api'

import { useOrbPanelStore } from './panel-store'
import { subscribeToOrbPanel } from './panel-wiring'
import { useOrbPlacementStore } from './placement-store'

/** The panel window's bootstrap — the counterpart of `useAppBootstrap`: the
 * data plane, then hydration (scan status, scan activity, placement,
 * currency, its two slices). It never fires the first scan: the main window
 * owns that. */
export function useOrbPanelBootstrap(): void {
  useEffect(() => {
    const unsubscribe = subscribeToOrbPanel()
    void (async () => {
      const status = await fetchScanStatus()
      if (status.ok && status.data.scanned) {
        useScanStore.setState({ hydrated: true })
        await useScanStore.getState().applyChange()
      }
      await Promise.all([
        useOrbPlacementStore.getState().sync(),
        useScanStore.getState().syncActivity(),
        useSettingsStore.getState().loadCurrency(),
        useOrbPanelStore.getState().whenLoaded(),
      ])
    })()
    return unsubscribe
  }, [])
}
