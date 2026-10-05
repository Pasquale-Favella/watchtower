import { useSettingsStore } from '@/features/settings/store'
import { fetchPendingOrbNotice, onOrbNotice, onOrbPlacement } from '@/shared/lib/api'

import { useOrbStore } from './store'

/** The orb's IPC wiring — its counterpart of app/stores/subscribe.ts (ADR
 * 0011), mounted next to the shared `subscribeToIpc()`: the orb-only
 * channels feed the orb store, never component state. Returns the teardown. */
export function subscribeToOrbIpc(): () => void {
  const unsubs: Array<() => void> = [
    onOrbPlacement(placement => useOrbStore.getState().onPlacement(placement)),
    onOrbNotice(notice => useOrbStore.getState().onNotice(notice)),
  ]

  // A notice raised before this page could listen (the very first close).
  void fetchPendingOrbNotice().then(result => {
    if (result.ok && result.data) useOrbStore.getState().onNotice(result.data)
  })

  // The persisted settings (theme…) are written by the main window; a
  // `storage` event is how a second window of the same origin hears about it.
  const settingsKey = useSettingsStore.persist.getOptions().name
  const onStorage = (event: StorageEvent): void => {
    if (event.key === settingsKey) void useSettingsStore.persist.rehydrate()
  }
  window.addEventListener('storage', onStorage)
  unsubs.push(() => window.removeEventListener('storage', onStorage))

  return () => {
    for (const unsub of unsubs) unsub()
  }
}
