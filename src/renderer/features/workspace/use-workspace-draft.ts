import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import { useCallback, useContext, useEffect } from 'react'

import type { ConversationId } from '@/shared/schemas/workspace.js'

import {
  hydrateWorkspaceDrafts,
  updateWorkspaceComposerPreferenceAtom,
  updateWorkspaceDraftAtom,
  workspaceComposerPreferencesAtom,
  workspaceDraftsAtom,
} from './draft-atoms.js'

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function useWorkspaceDraft(conversationId: ConversationId) {
  const registry = useContext(RegistryContext)
  const drafts = useAtomValue(workspaceDraftsAtom)
  const preferences = useAtomValue(workspaceComposerPreferencesAtom)
  const update = useAtomSet(updateWorkspaceDraftAtom)
  const updatePreference = useAtomSet(updateWorkspaceComposerPreferenceAtom)

  useEffect(() => hydrateWorkspaceDrafts(registry, browserStorage()), [registry])

  const setDraft = useCallback((text: string) => update({ conversationId, text }), [conversationId, update])
  const setPreferences = useCallback(
    (preference: { readonly checkoutId?: string; readonly connectionId?: string }) =>
      updatePreference({ conversationId, preference }),
    [conversationId, updatePreference],
  )

  return {
    draft: drafts[conversationId]?.text ?? '',
    setDraft,
    preferences: preferences[conversationId] ?? null,
    setPreferences,
  }
}
