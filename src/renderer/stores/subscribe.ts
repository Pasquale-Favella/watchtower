import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'

import { ApplicationClient } from '@/shared/lib/application-rpc'
import { runRoleLifecycle, type RoleConnectionReadiness } from '@/shared/lib/rpc-events'
import { RendererProtocolLayer } from '@/shared/lib/rpc-connection'
import { navigateToSection } from '../app/navigation.js'
import { registry, runtime } from '../app/renderer-runtime.js'

export const navigationReadinessAtom = Atom.keepAlive(Atom.make<RoleConnectionReadiness>('inactive'))
const navigationRuntime = runtime(get => Layer.merge(get(ApplicationClient.runtime.layer), RendererProtocolLayer))
export const navigationAtom = navigationRuntime.atom(get =>
  runRoleLifecycle(get, {
    readinessAtom: navigationReadinessAtom,
    events: () => Effect.map(ApplicationClient, rpc => rpc('shell:events', undefined)),
    apply: event =>
      Effect.sync(() => {
        if (event._tag === 'Ready') get.registry.set(navigationReadinessAtom, 'ready')
        else if (event._tag === 'Navigate') navigateToSection(event.section)
        return true
      }),
  }),
)
export function subscribeToNavigation(owner: AtomRegistry.AtomRegistry = registry): () => void {
  return owner.mount(navigationAtom)
}
