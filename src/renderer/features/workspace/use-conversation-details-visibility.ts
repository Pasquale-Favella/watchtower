import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import { useCallback, useContext, useState } from 'react'

import {
  browserConversationDetailsStorage,
  initialConversationDetailsOpen,
  transitionConversationDetailsState,
} from './conversation-details-visibility.js'
import {
  conversationDetailsVisibilityAtom,
  hydrateConversationDetailsVisibility,
  updateConversationDetailsVisibilityAtom,
} from './conversation-details-visibility-atoms.js'
import type { ConversationDetailsMode } from './use-conversation-details-layout.js'

interface PanelState {
  readonly key: string
  readonly mode: ConversationDetailsMode
  readonly open: boolean
}

/** Keeps inline visibility per Conversation while popover visibility remains transient. */
export function useConversationDetailsVisibility(
  key: string,
  mode: ConversationDetailsMode,
): { readonly open: boolean; readonly setOpen: (open: boolean) => void; readonly toggle: () => void } {
  const registry = useContext(RegistryContext)
  hydrateConversationDetailsVisibility(registry, browserConversationDetailsStorage())
  const preferences = useAtomValue(conversationDetailsVisibilityAtom)
  const updatePreference = useAtomSet(updateConversationDetailsVisibilityAtom)
  const [panel, setPanel] = useState<PanelState>(() => ({
    key,
    mode,
    open: initialConversationDetailsOpen(key, mode, preferences),
  }))
  const currentPanel = transitionConversationDetailsState(key, mode, panel, preferences)
  if (currentPanel !== panel) setPanel(currentPanel)
  const open = mode === 'inline' ? initialConversationDetailsOpen(key, mode, preferences) : currentPanel.open

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      setPanel({ key, mode, open: nextOpen })
      if (mode === 'inline') {
        updatePreference({ conversationId: key, open: nextOpen })
      }
    },
    [key, mode, updatePreference],
  )
  const toggle = useCallback(() => setOpen(!open), [open, setOpen])

  return { open, setOpen, toggle }
}
