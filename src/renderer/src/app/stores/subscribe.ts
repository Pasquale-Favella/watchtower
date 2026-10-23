import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'

import { registry } from '@/app/renderer-runtime'
import { coachEventAtom, replaceHarnessesAtom } from '@/features/coach-skills/atoms'
import { updateStatusChangedAtom } from '@/features/settings/updates-atoms'

import { navigateToSection } from '../navigation.js'
import { createWindowEventAtom } from './shared-wiring.js'

const appEvents = createWindowEventAtom('app', (event, owner) => {
  switch (event._tag) {
    case 'CoachEvent':
      owner.set(coachEventAtom, event.envelope)
      break
    case 'HarnessesChanged':
      owner.set(replaceHarnessesAtom, event.rows)
      break
    case 'UpdateChanged':
      owner.set(updateStatusChangedAtom, event.status)
      break
    case 'Navigate':
      navigateToSection(event.section)
      break
  }
})
export const appEventsReadyAtom = appEvents.readyAtom

export function subscribeToIpc(owner: AtomRegistry.AtomRegistry = registry): () => void {
  if (owner.get(appEvents.readyAtom) === 'inactive') owner.set(appEvents.readyAtom, 'pending')
  return owner.mount(appEvents.eventsAtom)
}
