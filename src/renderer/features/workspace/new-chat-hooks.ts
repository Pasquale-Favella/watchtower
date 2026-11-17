import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import * as Option from 'effect/Option'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import { useCallback, useContext, useEffect } from 'react'

import { hydrateWorkspaceDrafts, updateWorkspaceDraftAtom } from '@/renderer/features/workspace/draft-atoms.js'
import { pinWindowAtom, querySnapshot, useRemoteQuery } from '@/renderer/stores/hooks/use-remote-query.js'
import type { AgentAccessMode } from '@/shared/schemas/execution.js'
import type { ConversationId } from '@/shared/schemas/workspace.js'

import { workspaceQueryKey, type WorkspaceRequest } from './lib.js'
import {
  clearConversationDraftIfUnchangedAtom,
  clearNewChatDraftIfUnchangedAtom,
  ensureScratchProjectAtom,
  hydrateNewChatDraft,
  newChatDraftAtom,
  newChatProject,
  newChatProjects,
  saveConversationComposerPreferenceAtom,
  updateNewChatDraftAtom,
} from './new-chat-atoms.js'

function browserStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function useNewChatProjects(request: WorkspaceRequest<'workspace:listProjects'> | null) {
  const query = useRemoteQuery(newChatProjects, request, workspaceQueryKey)
  const refresh = useAtomSet(newChatProjects.refreshAtom)
  return { ...query, refresh: () => refresh(undefined) }
}

export function useNewChatProject(request: WorkspaceRequest<'workspace:getProject'> | null) {
  return useRemoteQuery(newChatProject, request, workspaceQueryKey)
}

function useNewChatCommand(atom: typeof ensureScratchProjectAtom) {
  const registry = useContext(RegistryContext)
  useEffect(() => pinWindowAtom(registry, atom), [registry, atom])
  const result = useAtomValue(atom)
  const execute = useAtomSet(atom, { mode: 'promise' })
  return {
    execute: () => execute(undefined),
    pending: result.waiting,
    data: Option.getOrNull(AsyncResult.value(result)),
    error: querySnapshot(result).error,
  }
}

export function useEnsureScratchProject() {
  return useNewChatCommand(ensureScratchProjectAtom)
}

export function useNewChatDraft() {
  const registry = useContext(RegistryContext)
  const text = useAtomValue(newChatDraftAtom)
  const update = useAtomSet(updateNewChatDraftAtom)
  const clearDraft = useAtomSet(clearNewChatDraftIfUnchangedAtom)
  const saveConversationDraft = useAtomSet(updateWorkspaceDraftAtom)
  const clearConversationDraftIfUnchanged = useAtomSet(clearConversationDraftIfUnchangedAtom)
  const saveComposerPreference = useAtomSet(saveConversationComposerPreferenceAtom)

  useEffect(() => hydrateNewChatDraft(registry, browserStorage()), [registry])
  useEffect(() => hydrateWorkspaceDrafts(registry, browserStorage()), [registry])

  const setDraft = useCallback((value: string) => update(value), [update])
  const copyDraftToConversation = useCallback(
    (conversationId: ConversationId, value: string) => saveConversationDraft({ conversationId, text: value }),
    [saveConversationDraft],
  )
  const clearConversationDraft = useCallback(
    (conversationId: ConversationId, expectedText: string) =>
      clearConversationDraftIfUnchanged({ conversationId, expectedText }),
    [clearConversationDraftIfUnchanged],
  )
  const saveConversationPreference = useCallback(
    (
      conversationId: ConversationId,
      checkoutId: string,
      connectionId: string,
      modelId = '',
      modeId = '',
      accessMode?: AgentAccessMode,
      configValues?: Readonly<Record<string, string>>,
    ) =>
      saveComposerPreference({
        conversationId,
        checkoutId,
        connectionId,
        modelId,
        modeId,
        ...(configValues ? { configValues } : {}),
        ...(accessMode ? { accessMode } : {}),
      }),
    [saveComposerPreference],
  )
  return {
    draft: text,
    setDraft,
    clearDraft,
    copyDraftToConversation,
    clearConversationDraft,
    saveConversationPreference,
  }
}
