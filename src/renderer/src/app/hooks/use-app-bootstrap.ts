import { useEffect } from 'react'

import { useScanStore } from '@/app/stores/scan-store'
import { subscribeToIpc } from '@/app/stores/subscribe'
import { useSettingsStore } from '@/features/settings/store'

/** The initial hydration flow + subscription lifecycle, relocated out of
 * AppRoot (ADR 0011): wires the six IPC subscriptions, then hydrates
 * the shell from the scan status — an existing report applies the change path
 * (status + providers + unparsed total), otherwise the first scan fires — and
 * loads the server-fed settings. */
export function useAppBootstrap(): void {
  useEffect(() => {
    const unsubscribe = subscribeToIpc()
    void (async () => {
      const hydrated = await useScanStore.getState().hydrate()
      if (hydrated === 'failed') return
      // The app window owns the first scan.
      if (hydrated === 'unscanned') await useScanStore.getState().refresh()
      await Promise.all([
        useSettingsStore.getState().loadCadence(),
        useSettingsStore.getState().loadCurrency(),
        useSettingsStore.getState().loadCurrencyOptions(),
      ])
    })()
    return unsubscribe
  }, [])
}
