import { useAtomSet } from '@effect/atom-react'
import { useEffect } from 'react'

import { registry } from '@/app/renderer-runtime'
import { useScanStore } from '@/app/stores/scan-store'
import { subscribeToIpc } from '@/app/stores/subscribe'
import { useCoachSkillsStore } from '@/features/coach-skills/store'
import { loadCadenceAtom, loadCurrencyAtom, loadCurrencyOptionsAtom } from '@/features/settings/atoms'
import { preferencesAtom } from '@/features/settings/preferences-atoms'
import { loadUpdateStatusAtom } from '@/features/settings/updates-atoms'

/** The initial hydration flow + subscription lifecycle, relocated out of
 * AppRoot (ADR 0011): wires the app's IPC subscriptions, then hydrates
 * the shell from the scan status — an existing report applies the change path
 * (status + providers + unparsed total), otherwise the first scan fires — and
 * loads the server-fed settings. */
export function useAppBootstrap(): void {
  const loadCadence = useAtomSet(loadCadenceAtom, { mode: 'promiseExit' })
  const loadCurrency = useAtomSet(loadCurrencyAtom, { mode: 'promiseExit' })
  const loadCurrencyOptions = useAtomSet(loadCurrencyOptionsAtom, { mode: 'promiseExit' })
  const loadUpdateStatus = useAtomSet(loadUpdateStatusAtom)

  useEffect(() => {
    const unsubscribe = subscribeToIpc()
    let thresholdKey = `${registry.get(preferencesAtom).skillsFrequency}\0${registry.get(preferencesAtom).skillsSpread}`
    const unsubscribePreferences = registry.subscribe(preferencesAtom, preferences => {
      const nextKey = `${preferences.skillsFrequency}\0${preferences.skillsSpread}`
      if (nextKey === thresholdKey) return
      thresholdKey = nextKey
      void useCoachSkillsStore.getState().detection.reload()
    })
    // Reads local updater state only. Checking GitHub still requires a click.
    loadUpdateStatus(undefined)
    void (async () => {
      const hydrated = await useScanStore.getState().hydrate()
      if (hydrated === 'failed') return
      // The app window owns the first scan.
      if (hydrated === 'unscanned') await useScanStore.getState().refresh()
      await Promise.all([loadCadence(undefined), loadCurrency(undefined), loadCurrencyOptions(undefined)])
    })()
    return () => {
      unsubscribePreferences()
      unsubscribe()
    }
  }, [loadCadence, loadCurrency, loadCurrencyOptions, loadUpdateStatus])
}
