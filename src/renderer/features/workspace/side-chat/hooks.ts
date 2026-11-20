import { RegistryContext, useAtomValue } from '@effect/atom-react'
import * as Option from 'effect/Option'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import { useContext, useEffect, useRef, useState } from 'react'

import { querySnapshot } from '@/renderer/stores/hooks/use-remote-query.js'
import type { ConversationId, TaskId } from '@/shared/schemas/workspace.js'
import type { CreateSideChatRequest, SideChatBringBackReceipt } from '@/shared/schemas/workspace-side-chats.js'

import { useWorkspaceDraft } from '../use-workspace-draft.js'
import { useWorkspaceOperation } from '../use-workspace-operation.js'
import {
  bringBackSideChatAtom,
  createSideChatAtom,
  deleteSideChatAtom,
  emptySideChatListAtom,
  sideChatBindingAtom,
  sideChatListAtom,
  type SideChatTabInfo,
  sideChatTabsAtom,
} from './side-chat-atoms.js'
import type { SideChatTabState } from './status.js'

const SIDE_CHAT_BINDING_POLL_MS = 3000

function isSideChatNotFound(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === 'not-found'
}

export function useSideChatBinding(id: string) {
  const registry = useContext(RegistryContext)
  const result = useAtomValue(sideChatBindingAtom(id))
  const failure = AsyncResult.error(result)
  // A deleted side chat fails its lookup with `not-found`; any other failure stays an error message.
  const deleted = Option.isSome(failure) && isSideChatNotFound(failure.value)
  useEffect(() => {
    if (deleted) return
    // The binding is not a workspace query, so an open pane polls it to notice a side chat deleted elsewhere.
    const timer = setInterval(() => registry.refresh(sideChatBindingAtom(id)), SIDE_CHAT_BINDING_POLL_MS)
    return () => clearInterval(timer)
  }, [deleted, id, registry])
  return { ...querySnapshot(result), deleted }
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
/** Deletes a side chat. A close passes `onlyIfUnused`, so a side chat that already ran is kept. */
export function useDeleteSideChat() {
  const registry = useContext(RegistryContext)
  const command = useWorkspaceOperation(deleteSideChatAtom)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  return {
    error,
    pending,
    remove: async (input: {
      readonly id: string
      readonly parentTaskId?: TaskId | null | undefined
      readonly onlyIfUnused?: boolean | undefined
    }): Promise<boolean> => {
      setPending(true)
      setError(null)
      try {
        const receipt = await command({ id: input.id, ...(input.onlyIfUnused ? { onlyIfUnused: true } : {}) })
        return receipt.deleted
      } catch (cause) {
        // A side chat that is already gone has nothing left to remove.
        if (isSideChatNotFound(cause)) return true
        setError(cause instanceof Error ? cause.message : 'Could not delete this side chat.')
        return false
      } finally {
        if (input.parentTaskId) registry.refresh(sideChatListAtom(input.parentTaskId))
        setPending(false)
      }
    },
  }
}
/** Brings a side chat's history to the main chat's next Run. The main chat receives it as a pending transfer. */
export function useBringBackSideChat(id: string) {
  const command = useWorkspaceOperation(bringBackSideChatAtom)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<SideChatBringBackReceipt | null>(null)
  return {
    pending,
    error,
    receipt,
    bringBack: async (): Promise<SideChatBringBackReceipt | null> => {
      if (pending) return null
      setPending(true)
      setError(null)
      try {
        const result = await command({ id })
        setReceipt(result)
        return result
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not bring back this side chat.')
        return null
      } finally {
        setPending(false)
      }
    },
  }
}
/** The parent's side chat list shows each side chat's title, so it reloads when a side chat's live title changes. */
export function useSideChatTitleRefresh(parentTaskId: TaskId, title: string): void {
  const registry = useContext(RegistryContext)
  const shown = useRef(title)
  useEffect(() => {
    if (shown.current === title) return
    shown.current = title
    registry.refresh(sideChatListAtom(parentTaskId))
  }, [parentTaskId, registry, title])
}

/** The side draft starts with the main chat's composer preferences, on the side chat's shared checkout. */
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
    side.setPreferences({ ...parent.preferences, checkoutId })
  }, [checkoutId, parent.preferences, side])
}

/** Every open side chat's published tab title and state, keyed by side chat id. */
export function useSideChatTabs(): Readonly<Record<string, SideChatTabInfo>> {
  return useAtomValue(sideChatTabsAtom)
}

/** Publishes a pane's live title and tab state for the tab strip and the main chat, and clears them on unmount. */
export function usePublishSideChatTab(id: string, title: string, state: SideChatTabState | null): void {
  const registry = useContext(RegistryContext)
  useEffect(() => {
    const current = registry.get(sideChatTabsAtom)[id]
    if (current?.title === title && current.state === state) return
    registry.set(sideChatTabsAtom, { ...registry.get(sideChatTabsAtom), [id]: { title, state } })
  }, [registry, id, title, state])
  useEffect(
    () => () => {
      const remaining = Object.fromEntries(Object.entries(registry.get(sideChatTabsAtom)).filter(([key]) => key !== id))
      registry.set(sideChatTabsAtom, remaining)
    },
    [registry, id],
  )
}
