import * as Atom from 'effect/reactivity/Atom'
import type * as AtomRegistry from 'effect/reactivity/AtomRegistry'

import type { ConversationId } from '@/shared/schemas/workspace.js'

import {
  readWorkspaceComposerPreferences,
  readWorkspaceDrafts,
  type WorkspaceComposerPreference,
  type WorkspaceComposerPreferences,
  type WorkspaceDrafts,
  type WorkspaceDraftStorage,
  writeWorkspaceComposerPreference,
  writeWorkspaceDraft,
} from './draft-storage.js'

export const workspaceDraftsAtom = Atom.keepAlive(Atom.make<WorkspaceDrafts>({}))
export const workspaceComposerPreferencesAtom = Atom.keepAlive(Atom.make<WorkspaceComposerPreferences>({}))
const workspaceDraftStorageAtom = Atom.keepAlive(Atom.make<WorkspaceDraftStorage | null>(null))
const hydratedRegistries = new WeakSet<AtomRegistry.AtomRegistry>()

export function hydrateWorkspaceDrafts(
  registry: AtomRegistry.AtomRegistry,
  storage: WorkspaceDraftStorage | null,
): void {
  if (hydratedRegistries.has(registry)) return
  hydratedRegistries.add(registry)
  registry.set(workspaceDraftStorageAtom, storage)
  registry.set(workspaceDraftsAtom, readWorkspaceDrafts(storage))
  registry.set(workspaceComposerPreferencesAtom, readWorkspaceComposerPreferences(storage))
}

export const updateWorkspaceDraftAtom = Atom.writable(
  get => get(workspaceDraftsAtom),
  (context, update: { readonly conversationId: ConversationId; readonly text: string }) => {
    context.set(
      workspaceDraftsAtom,
      writeWorkspaceDraft(
        context.get(workspaceDraftStorageAtom),
        context.get(workspaceDraftsAtom),
        update.conversationId,
        update.text,
      ),
    )
  },
)

export const updateWorkspaceComposerPreferenceAtom = Atom.writable(
  get => get(workspaceComposerPreferencesAtom),
  (
    context,
    update: {
      readonly conversationId: ConversationId
      readonly preference: Omit<WorkspaceComposerPreference, 'updatedAt'>
    },
  ) => {
    context.set(
      workspaceComposerPreferencesAtom,
      writeWorkspaceComposerPreference(
        context.get(workspaceDraftStorageAtom),
        context.get(workspaceComposerPreferencesAtom),
        update.conversationId,
        { ...context.get(workspaceComposerPreferencesAtom)[update.conversationId], ...update.preference },
      ),
    )
  },
)
