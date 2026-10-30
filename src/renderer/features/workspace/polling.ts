import * as Effect from 'effect/Effect'
import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'

export interface WorkspaceQueryRefreshTarget {
  readonly refreshAtom: Atom.Writable<unknown, void>
}

interface WorkspaceQueryPollingOptions<Requirements> {
  readonly targets: readonly WorkspaceQueryRefreshTarget[]
  readonly beforeRefresh?: Effect.Effect<unknown, never, Requirements>
  readonly intervalMs?: number
}

/** Retained query data outlives views; only mounted consumers own fallback polling. */
export function createWorkspaceQueryPolling<Requirements, Error>(
  runtime: Atom.AtomRuntime<Requirements, Error>,
  options: WorkspaceQueryPollingOptions<Requirements>,
) {
  const visibleAtom = Atom.readable(get => {
    const document = globalThis.document
    // Headless consumers have no visibility API; Electron renderer windows do.
    if (!document) return true
    const onVisibilityChange = () => get.setSelf(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', onVisibilityChange)
    get.addFinalizer(() => document.removeEventListener('visibilitychange', onVisibilityChange))
    return document.visibilityState !== 'hidden'
  })
  const consumersAtom = Atom.keepAlive(Atom.make<ReadonlyMap<WorkspaceQueryRefreshTarget, number>>(new Map()))
  const refresh = (registry: AtomRegistry.AtomRegistry, targets: readonly WorkspaceQueryRefreshTarget[]): void => {
    const consumers = registry.get(consumersAtom)
    for (const target of targets) {
      if ((consumers.get(target) ?? 0) > 0) registry.set(target.refreshAtom, undefined)
    }
  }
  const pollingAtom = runtime.atom(get => {
    const consumers = get(consumersAtom)
    const targets = options.targets.filter(target => (consumers.get(target) ?? 0) > 0)
    if (targets.length === 0 || !get(visibleAtom)) return Effect.void
    return Effect.forever(
      Effect.sleep(options.intervalMs ?? 3000).pipe(
        Effect.andThen(options.beforeRefresh ?? Effect.void),
        Effect.andThen(Effect.sync(() => refresh(get.registry, targets))),
      ),
    )
  })
  const retain = (registry: AtomRegistry.AtomRegistry, target: WorkspaceQueryRefreshTarget): (() => void) => {
    const consumers = new Map(registry.get(consumersAtom))
    consumers.set(target, (consumers.get(target) ?? 0) + 1)
    registry.set(consumersAtom, consumers)
    const unmount = registry.mount(pollingAtom)
    let retained = true
    return () => {
      if (!retained) return
      retained = false
      const remaining = new Map(registry.get(consumersAtom))
      const count = (remaining.get(target) ?? 1) - 1
      if (count === 0) remaining.delete(target)
      else remaining.set(target, count)
      registry.set(consumersAtom, remaining)
      unmount()
    }
  }
  return { retain, refresh }
}
