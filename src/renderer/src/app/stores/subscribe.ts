import { onCoachHarnessesChanged, parseEvent } from '@/shared/lib/api'

import { coachEventEnvelopeSchema } from '../../../../shared/schemas/agents.js'
import { activeCurrencySchema } from '../../../../shared/schemas/fx.js'
import { scanProgressMessageSchema, storeChangedMessageSchema } from '../../../../shared/schemas/ipc.js'
import { useCoachSkillsStore } from '../../features/coach-skills/store'
import { useSettingsStore } from '../../features/settings/store'
import { useScanStore } from './scan-store'

/** The central IPC wiring (ADR 0011): all six `window.api.on*`
 * subscriptions feed store actions, never component state. Call once from the
 * shell's mount; the returned teardown removes every listener. Stores stay
 * pure (no `window` at module load), so this is the only `window`-touching
 * module in the layer besides `lib/api.ts`. */
export function subscribeToIpc(): () => void {
  const unsubs: Array<() => void> = []

  unsubs.push(
    window.api.onProgress(progress => {
      // Tripwire (ADR 0005): a malformed broadcast is dropped, never painted.
      const parsed = parseEvent(scanProgressMessageSchema, 'scan progress', progress)
      if (!parsed) return
      useScanStore
        .getState()
        .onProgress(parsed.provider ?? '', parsed.processed ?? 0, parsed.total ?? 0, parsed.stage === 'port-in')
    }),
  )

  unsubs.push(window.api.onError(message => useScanStore.getState().onError(message)))

  unsubs.push(
    window.api.onChanged(message => {
      const parsed = parseEvent(storeChangedMessageSchema, 'store changed', message)
      if (!parsed) return
      void useScanStore.getState().applyChange()
    }),
  )

  unsubs.push(window.api.onIdle(() => useScanStore.getState().onIdle()))

  // A background FX fetch landed a fresh rate (ADR 0009) — repaint money
  // values with it, replacing the fallback rate the selection returned.
  unsubs.push(
    window.api.onCurrencyChanged(next => {
      const parsed = parseEvent(activeCurrencySchema, 'currency changed', next)
      if (!parsed) return
      useSettingsStore.getState().onCurrencyChanged(parsed)
    }),
  )

  // A config write (price override / model alias) lands: refetch via the scan
  // store's change path — no rebuild, no rescan.
  unsubs.push(
    window.api.onConfigChanged(() => {
      void useScanStore.getState().applyChange()
    }),
  )

  // A harness run streamed an event (ADR 0017): route it into the unified
  // Coach & Skills store so the thread accumulates text/tools/session live.
  unsubs.push(
    window.api.onCoachEvent(message => {
      const parsed = parseEvent(coachEventEnvelopeSchema, 'coach event', message)
      if (!parsed) return
      useCoachSkillsStore.getState().onEvent(parsed)
    }),
  )

  unsubs.push(
    onCoachHarnessesChanged(rows => {
      useCoachSkillsStore.getState().replaceHarnesses(rows)
    }),
  )

  return () => {
    for (const unsub of unsubs) unsub()
  }
}
