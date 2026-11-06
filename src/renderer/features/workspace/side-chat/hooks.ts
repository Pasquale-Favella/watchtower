import { RegistryContext, useAtomValue } from '@effect/atom-react'
import { useContext, useEffect, useRef, useState } from 'react'

import { querySnapshot } from '@/renderer/stores/hooks/use-remote-query.js'
import type { ConversationId, TaskId } from '@/shared/schemas/workspace.js'
import type { CreateSideChatRequest } from '@/shared/schemas/workspace-side-chats.js'

import { updateWorkspaceDraftAtom, workspaceDraftsAtom } from '../draft-atoms.js'
import { WORKSPACE_DRAFT_MAX_LENGTH } from '../draft-storage.js'
import { useWorkspaceDraft } from '../use-workspace-draft.js'
import { useWorkspaceOperation } from '../use-workspace-operation.js'
import {
  bringBackSideChatAtom,
  createSideChatAtom,
  emptySideChatListAtom,
  sideChatBindingAtom,
  sideChatListAtom,
} from './side-chat-atoms.js'

export function useSideChatBinding(id: string) {
  const atom = sideChatBindingAtom(id)
  return querySnapshot(useAtomValue(atom))
}
export function useSideChats(parentTaskId: TaskId | null) {
  const query = querySnapshot(useAtomValue(parentTaskId ? sideChatListAtom(parentTaskId) : emptySideChatListAtom))
  return { ...query, items: query.data?.items ?? [] }
}
export function useCreateSideChat() {
  const registry = useContext(RegistryContext)
  const command = useWorkspaceOperation(createSideChatAtom)
  const pending = useRef(false)
  const intent = useRef<CreateSideChatRequest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  return {
    error,
    pending: creating,
    create: async (input: Omit<CreateSideChatRequest, 'commandId'>) => {
      if (pending.current) return null
      pending.current = true
      setCreating(true)
      setError(null)
      if (
        intent.current &&
        (intent.current.parentTaskId !== input.parentTaskId ||
          intent.current.parentConversationId !== input.parentConversationId ||
          intent.current.checkoutId !== input.checkoutId ||
          intent.current.title !== input.title)
      )
        intent.current = null
      if (!intent.current) intent.current = { ...input, commandId: crypto.randomUUID() }
      try {
        const result = await command(intent.current)
        registry.refresh(sideChatListAtom(input.parentTaskId))
        intent.current = null
        return result
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not open a side chat.')
        throw cause
      } finally {
        pending.current = false
        setCreating(false)
      }
    },
  }
}
export function useBringBackSideChat(parentConversationId: ConversationId) {
  const registry = useContext(RegistryContext)
  const command = useWorkspaceOperation(bringBackSideChatAtom)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return {
    pending,
    error,
    bringBack: async (id: string, selection?: string) => {
      if (pending) return false
      setPending(true)
      setError(null)
      try {
        const text = selection ? `Side chat selection:\n${selection}` : (await command({ id })).text
        const current = registry.get(workspaceDraftsAtom)[parentConversationId]?.text ?? ''
        if (current.length + text.length + (current ? 2 : 0) > WORKSPACE_DRAFT_MAX_LENGTH) {
          setError('The reply does not fit in the main chat draft. Copy a shorter selection from this reply.')
          return false
        }
        registry.set(updateWorkspaceDraftAtom, {
          conversationId: parentConversationId,
          text: `${current}${current ? '\n\n' : ''}${text}`,
        })
        return true
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not bring this reply back.')
        return false
      } finally {
        setPending(false)
      }
    },
  }
}
export function useSideChatPreferences(
  parentConversationId: ConversationId,
  conversationId: ConversationId,
  checkoutId: string,
) {
  const parent = useWorkspaceDraft(parentConversationId)
  const side = useWorkspaceDraft(conversationId)
  const initialized = useRef(false)
  useEffect(() => {
    if (initialized.current || side.preferences) return
    initialized.current = true
    side.setPreferences({ ...parent.preferences, checkoutId, accessMode: 'approval-required' })
  }, [checkoutId, parent.preferences, side])
}
