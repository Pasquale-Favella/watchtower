import { useAtomValue } from '@effect/atom-react'

import { useSettingsPreferencesStore } from '@/renderer/features/settings/use-settings-store.js'
import { appLifecycleReadinessAtom } from '@/renderer/stores/atoms/rpc-lifecycle.js'
import { useScanHydrated } from '@/renderer/stores/hooks/use-scan-store.js'

export function useShellStore() {
  const hydrated = useScanHydrated()
  const { preferences } = useSettingsPreferencesStore()
  const connectionMessage = useAtomValue(appLifecycleReadinessAtom).message

  return { hydrated, onboarded: preferences.onboarded, connectionMessage }
}
