import * as Effect from 'effect/Effect'
import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Stream from 'effect/Stream'

import { NavigationEvents } from '@/shared/lib/navigation-events'

import { navigateToSection } from '../navigation.js'
import { registry, runtime } from '../renderer-runtime.js'

export const navigationReadinessAtom = Atom.keepAlive(
  Atom.make<'inactive' | 'pending' | 'ready' | 'failed'>('inactive'),
)

const navigationAtom = runtime(NavigationEvents.layer).atom(get => {
  get.registry.set(navigationReadinessAtom, 'pending')
  return Effect.flatMap(NavigationEvents, source =>
    Stream.runForEach(
      source.events(() => get.registry.set(navigationReadinessAtom, 'ready')),
      section => Effect.sync(() => navigateToSection(section)),
    ),
  ).pipe(Effect.catch(() => Effect.sync(() => get.registry.set(navigationReadinessAtom, 'failed'))))
})

/** Multiple root holders share one navigation listener until the final release. */
export function subscribeToNavigation(owner: AtomRegistry.AtomRegistry = registry): () => void {
  return owner.mount(navigationAtom)
}
