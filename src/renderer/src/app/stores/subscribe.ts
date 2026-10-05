import { onAppNavigate, onCoachHarnessesChanged, parseEvent } from '@/shared/lib/api'

import { coachEventEnvelopeSchema } from '../../../../shared/schemas/agents.js'
import { useCoachSkillsStore } from '../../features/coach-skills/store'
import { navigateToSection } from '../navigation'
import { subscribeToDataPlane } from './shared-wiring'

/** The app window's IPC wiring (ADR 0011): the shared data plane plus the
 * channels only this window serves — Coach events and the orb's "open on a
 * section" requests. Every subscription feeds a store action (or, for
 * navigation, its one entry point), never component state. Call once from
 * the shell's mount; the returned teardown removes every listener. Stores
 * stay pure (no `window` at module load): only the wiring modules and
 * `lib/api.ts` touch `window`. */
export function subscribeToIpc(): () => void {
  const unsubs: Array<() => void> = [subscribeToDataPlane()]

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

  // The background orb asked to open the app on a section: navigation's one
  // entry point is app/navigation.ts (ADR 0014), the same the sidebar uses.
  unsubs.push(onAppNavigate(navigateToSection))

  return () => {
    for (const unsub of unsubs) unsub()
  }
}
