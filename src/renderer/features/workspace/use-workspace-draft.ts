import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import { useCallback, useContext, useEffect } from 'react'

import type { AgentAccessMode } from '@/shared/schemas/execution.js'
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
    (preference: {
      readonly checkoutId?: string
      readonly connectionId?: string
      readonly modelId?: string
      readonly modeId?: string
      readonly configValues?: Readonly<Record<string, string>>
      readonly accessMode?: AgentAccessMode
      readonly resumeNativeContext?: boolean
      readonly resumeSessionId?: string
    }) => updatePreference({ conversationId, preference }),
    [conversationId, updatePreference],
  )

  return {
    draft: drafts[conversationId]?.text ?? '',
    setDraft,
    preferences: preferences[conversationId] ?? null,
    setPreferences,
  }
}

/** Appends an `@path` reference to a Conversation's draft, for actions outside the composer. */
export function useDraftReference() {
  const drafts = useAtomValue(workspaceDraftsAtom)
  const update = useAtomSet(updateWorkspaceDraftAtom)
  return useCallback(
    (conversationId: ConversationId, path: string) => {
      const text = drafts[conversationId]?.text ?? ''
      const separator = text && !/\s$/.test(text) ? ' ' : ''
      update({ conversationId, text: `${text}${separator}@${path} ` })
    },
    [drafts, update],
  )
}

export function useDraftAppend() {
  const drafts = useAtomValue(workspaceDraftsAtom)
  const update = useAtomSet(updateWorkspaceDraftAtom)
  return useCallback(
    (conversationId: ConversationId, addition: string) => {
      const text = drafts[conversationId]?.text ?? ''
      update({ conversationId, text: `${text}${text ? '\n\n' : ''}${addition}` })
    },
    [drafts, update],
  )
}
