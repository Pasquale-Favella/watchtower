import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'

import {
  defaultWorkspaceNavigationState,
  mergeWorkspaceNavigation,
  readWorkspaceNavigation,
  type WorkspaceNavigationState,
  type WorkspaceNavigationStorage,
  writeWorkspaceNavigation,
} from './workspace-navigation.js'

export const workspaceNavigationAtom = Atom.keepAlive(Atom.make(defaultWorkspaceNavigationState))

const workspaceNavigationStorageAtom = Atom.keepAlive(Atom.make<WorkspaceNavigationStorage | null>(null))
const hydratedRegistries = new WeakSet<AtomRegistry.AtomRegistry>()

/** Loads persisted navigation once for this window registry. */
export function hydrateWorkspaceNavigation(
  registry: AtomRegistry.AtomRegistry,
  storage: WorkspaceNavigationStorage | null,
): void {
  if (hydratedRegistries.has(registry)) return
  hydratedRegistries.add(registry)
  registry.set(workspaceNavigationStorageAtom, storage)
  registry.set(workspaceNavigationAtom, readWorkspaceNavigation(storage))
}

/** Applies and persists navigation updates in the current window registry. */
export const updateWorkspaceNavigationAtom = Atom.writable(
  get => get(workspaceNavigationAtom),
  (context, update: Partial<WorkspaceNavigationState>) => {
    const next = mergeWorkspaceNavigation(context.get(workspaceNavigationAtom), update)
    context.set(workspaceNavigationAtom, next)
    writeWorkspaceNavigation(context.get(workspaceNavigationStorageAtom), next)
  },
)
