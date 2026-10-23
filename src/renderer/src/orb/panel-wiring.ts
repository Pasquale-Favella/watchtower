import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'

import { registry } from '@/app/renderer-runtime'
import { createWindowEventAtom } from '@/app/stores/shared-wiring'

import { placementAtom } from './placement-atoms.js'

const events = createWindowEventAtom('panel', (event, owner) => {
  if (event._tag === 'Placement') owner.set(placementAtom, event.placement)
})

export const panelEventsReadyAtom = events.readyAtom

export function subscribeToOrbPanel(owner: AtomRegistry.AtomRegistry = registry): () => void {
  if (owner.get(events.readyAtom) === 'inactive') owner.set(events.readyAtom, 'pending')
  return owner.mount(events.eventsAtom)
}
