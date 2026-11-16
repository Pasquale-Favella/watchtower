import { useCallback, useState } from 'react'

const STORAGE_KEY = 'watchtower.workspace.conversation-details-items.v1'

export const CONVERSATION_DETAILS_ITEMS = [
  { id: 'workspace', label: 'Workspace' },
  { id: 'branch', label: 'Branch' },
  { id: 'changes', label: 'Diff' },
  { id: 'pullRequests', label: 'Pull requests' },
  { id: 'sideChats', label: 'Side chats' },
] as const

export type ConversationDetailsItemId = (typeof CONVERSATION_DETAILS_ITEMS)[number]['id']
export type ConversationDetailsItems = Readonly<Record<ConversationDetailsItemId, boolean>>

const defaultVisible = Object.fromEntries(CONVERSATION_DETAILS_ITEMS.map(({ id }) => [id, true])) as Record<
  ConversationDetailsItemId,
  boolean
>

function browserStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function decodeConversationDetailsItems(raw: string | null): ConversationDetailsItems {
  if (!raw || raw.length > 10_000) return defaultVisible
  try {
    const decoded: unknown = JSON.parse(raw)
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return defaultVisible
    const visible = { ...defaultVisible }
    for (const { id } of CONVERSATION_DETAILS_ITEMS) {
      if (Object.hasOwn(decoded, id) && typeof (decoded as Record<string, unknown>)[id] === 'boolean') {
        visible[id] = (decoded as Record<string, boolean>)[id]
      }
    }
    return visible
  } catch {
    return defaultVisible
  }
}

function readItems(): ConversationDetailsItems {
  try {
    return decodeConversationDetailsItems(browserStorage()?.getItem(STORAGE_KEY) ?? null)
  } catch {
    return defaultVisible
  }
}

function persistItems(items: ConversationDetailsItems): void {
  try {
    browserStorage()?.setItem(STORAGE_KEY, JSON.stringify(items))
  } catch {
    /* The current window keeps the user's choices when storage is unavailable. */
  }
}

export function useConversationDetailsItems(): {
  readonly visible: ConversationDetailsItems
  readonly setVisible: (id: ConversationDetailsItemId, visible: boolean) => void
  readonly reset: () => void
} {
  const [visible, setVisibility] = useState<ConversationDetailsItems>(readItems)
  const setVisible = useCallback(
    (id: ConversationDetailsItemId, isVisible: boolean) => {
      const next = { ...visible, [id]: isVisible }
      setVisibility(next)
      persistItems(next)
    },
    [visible],
  )
  const reset = useCallback(() => {
    setVisibility(defaultVisible)
    try {
      browserStorage()?.removeItem(STORAGE_KEY)
    } catch {
      /* Reset still applies in this window when storage is unavailable. */
    }
  }, [])

  return { visible, setVisible, reset }
}
