import { useAtomValue } from '@effect/atom-react'

import { useSettingsPreferencesStore } from '../../features/settings/use-settings-store.js'
import { appLifecycleReadinessAtom } from '../atoms/rpc-lifecycle.js'
import { useScanHydrated } from './use-scan-store.js'

export function useShellStore() {
  const hydrated = useScanHydrated()
  const { preferences } = useSettingsPreferencesStore()
  const connectionMessage = useAtomValue(appLifecycleReadinessAtom).message

  return { hydrated, onboarded: preferences.onboarded, connectionMessage }
}
