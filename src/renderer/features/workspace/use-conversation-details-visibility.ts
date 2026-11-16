import { useCallback, useState } from 'react'

import {
  browserConversationDetailsStorage,
  initialConversationDetailsOpen,
  readConversationDetailsPreferences,
  rememberConversationDetailsOpen,
  transitionConversationDetailsState,
} from './conversation-details-visibility.js'
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
  const [preferences, setPreferences] = useState(() =>
    readConversationDetailsPreferences(browserConversationDetailsStorage()),
  )
  const [panel, setPanel] = useState<PanelState>(() => ({
    key,
    mode,
    open: initialConversationDetailsOpen(key, mode, preferences),
  }))
  const currentPanel = transitionConversationDetailsState(key, mode, panel, preferences)
  if (currentPanel !== panel) setPanel(currentPanel)
  const open = currentPanel.open

  const setOpen = useCallback(
    (nextOpen: boolean) => {
      setPanel({ key, mode, open: nextOpen })
      if (mode === 'inline') {
        setPreferences(rememberConversationDetailsOpen(browserConversationDetailsStorage(), preferences, key, nextOpen))
      }
    },
    [key, mode, preferences],
  )
  const toggle = useCallback(() => setOpen(!open), [open, setOpen])

  return { open, setOpen, toggle }
}
