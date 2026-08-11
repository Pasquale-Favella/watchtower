import { useEffect } from 'react'

import { fetchScanStatus } from '@/shared/lib/api'
import { useScanStore } from '@/app/stores/scan-store'
import { useSettingsStore } from '@/features/settings/store'
import { subscribeToIpc } from '@/app/stores/subscribe'

/** The initial hydration flow + subscription lifecycle, relocated out of
 * AppRoot (ADR 0011): wires the six IPC subscriptions, then hydrates
 * the shell from the scan status — an existing report applies the change path
 * (status + providers + unparsed total), otherwise the first scan fires — and
 * loads the server-fed settings. */
export function useAppBootstrap(): void {
  useEffect(() => {
    const unsubscribe = subscribeToIpc()
    void (async () => {
      const status = await fetchScanStatus()
      if (!status.ok) return
      if (status.data.scanned) {
        useScanStore.setState({ hydrated: true })
        await useScanStore.getState().applyChange()
      } else {
        await useScanStore.getState().refresh()
      }
      await Promise.all([
        useSettingsStore.getState().loadCadence(),
        useSettingsStore.getState().loadCurrency(),
        useSettingsStore.getState().loadCurrencyOptions(),
      ])
    })()
    return unsubscribe
  }, [])
}
