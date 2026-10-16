import { parseEvent } from '@/shared/lib/api'

import { activeCurrencySchema } from '../../../../shared/schemas/fx.js'
import { scanProgressMessageSchema, storeChangedMessageSchema } from '../../../../shared/schemas/ipc.js'
import { useSettingsStore } from '../../features/settings/store'
import { useScanStore } from './scan-store'

/**
 * The IPC wiring every window shares (ADR 0011, amended): each window's own
 * wiring module (`subscribe.ts` for the app, `orb/beacon-wiring.ts` and
 * `orb/panel-wiring.ts` for the orb's two windows) composes these with its
 * own channels, so a window loads only the stores it uses. Like every wiring module, these feed store actions,
 * never component state, and return their teardown.
 */

type Teardown = () => void

/** One teardown for several subscriptions. */
export function combine(unsubs: Teardown[]): Teardown {
  return () => {
    for (const unsub of unsubs) unsub()
  }
}

/** The scan lifecycle the main process broadcasts to every window (manual or
 * background, whichever window started it) → the scan store. `onSettled`
 * is what a finished scan's `store:changed` does in this window. */
export function subscribeToScanLifecycle(onSettled: () => void): Teardown {
  return combine([
    window.api.onProgress(progress => {
      // Tripwire (ADR 0005): a malformed broadcast is dropped, never painted.
      const parsed = parseEvent(scanProgressMessageSchema, 'scan progress', progress)
      if (!parsed) return
      useScanStore
        .getState()
        .onProgress(parsed.provider ?? '', parsed.processed ?? 0, parsed.total ?? 0, parsed.stage === 'port-in')
    }),
    window.api.onError(message => useScanStore.getState().onError(message)),
    window.api.onChanged(message => {
      const parsed = parseEvent(storeChangedMessageSchema, 'store changed', message)
      if (parsed) onSettled()
    }),
    window.api.onIdle(() => useScanStore.getState().onIdle()),
  ])
}

/** The data plane for a window that shows ledger data: the scan lifecycle,
 * with `store:changed` / `config:changed` driving the shared refresh tick
 * (ADR 0004 — the only refetch triggers), plus FX rate updates. */
export function subscribeToDataPlane(): Teardown {
  return combine([
    subscribeToScanLifecycle(() => void useScanStore.getState().applyChange()),
    // A config write (price override / model alias) lands: refetch via the
    // scan store's change path — no rebuild, no rescan.
    window.api.onConfigChanged(() => {
      void useScanStore.getState().applyChange()
    }),
    // A background FX fetch landed a fresh rate (ADR 0009) — repaint money
    // values with it, replacing the fallback rate the selection returned.
    window.api.onCurrencyChanged(next => {
      const parsed = parseEvent(activeCurrencySchema, 'currency changed', next)
      if (!parsed) return
      useSettingsStore.getState().onCurrencyChanged(parsed)
    }),
  ])
}

/** For a secondary window: follow the settings (theme…) the main window
 * persists. Every page loads from the same origin (the dev server, or
 * file:// in a build), so they share localStorage, and a `storage` event is
 * how one window hears another write it. */
export function subscribeToSettingsSync(): Teardown {
  const settingsKey = useSettingsStore.persist.getOptions().name
  const onStorage = (event: StorageEvent): void => {
    if (event.key === settingsKey) void useSettingsStore.persist.rehydrate()
  }
  window.addEventListener('storage', onStorage)
  return () => window.removeEventListener('storage', onStorage)
}
