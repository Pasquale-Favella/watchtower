import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import { useCallback, useContext } from 'react'

import {
  CONVERSATION_DETAILS_ITEMS,
  type ConversationDetailsItemId,
  type ConversationDetailsItems,
  decodeConversationDetailsItems,
} from './conversation-details-items.js'
import type { ConversationDetailsItemsAtomStorage } from './conversation-details-items-atoms.js'
import {
  conversationDetailsItemsAtom,
  hydrateConversationDetailsItems,
  resetConversationDetailsItemsAtom,
  setConversationDetailsItemVisibilityAtom,
} from './conversation-details-items-atoms.js'

export { CONVERSATION_DETAILS_ITEMS, decodeConversationDetailsItems }
export type { ConversationDetailsItemId, ConversationDetailsItems }

function browserStorage(): ConversationDetailsItemsAtomStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

export function useConversationDetailsItems(): {
  readonly visible: ConversationDetailsItems
  readonly setVisible: (id: ConversationDetailsItemId, visible: boolean) => void
  readonly reset: () => void
} {
  const registry = useContext(RegistryContext)
  hydrateConversationDetailsItems(registry, browserStorage())
  const visible = useAtomValue(conversationDetailsItemsAtom)
  const setVisibility = useAtomSet(setConversationDetailsItemVisibilityAtom)
  const resetVisibility = useAtomSet(resetConversationDetailsItemsAtom)
  const setVisible = useCallback(
    (id: ConversationDetailsItemId, isVisible: boolean) => setVisibility({ id, visible: isVisible }),
    [setVisibility],
  )
  const reset = useCallback(() => resetVisibility(undefined), [resetVisibility])

  return { visible, setVisible, reset }
}
