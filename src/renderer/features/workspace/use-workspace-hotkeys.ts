import { useAtomSet } from '@effect/atom-react'
import { useHotkeys } from '@tanstack/react-hotkeys'

import { SHORTCUTS } from '@/renderer/app/shortcuts'

import { updateWorkspaceNavigationAtom } from './navigation-atoms.js'
import { isTerminalFocusTarget } from './terminal/terminal-keys.js'
import { useWorkspaceProjectDialog } from './use-project-dialog.js'

/** The Workspace-scoped shortcut entries (Add project, New chat without a project). */
export const WORKSPACE_SHORTCUTS = SHORTCUTS.filter(def => def.scope === 'workspace')

/** An open dialog, alert dialog or menu (the app's popups render these roles; a closing one carries `data-closed`). */
export const OPEN_OVERLAY_SELECTOR = [
  '[role="dialog"]:not([data-closed])',
  '[role="alertdialog"]:not([data-closed])',
  '[role="menu"]:not([data-closed])',
].join(', ')

/** Whether any dialog, modal or menu is open anywhere in the document. */
export function isOverlayOpen(root: Pick<ParentNode, 'querySelector'>): boolean {
  return root.querySelector(OPEN_OVERLAY_SELECTOR) !== null
}

/**
 * Whether a Workspace shortcut may act: not while an overlay is open (the command palette, Settings, an alert
 * dialog, a menu or popover, or the add-project dialog itself) and not while a terminal has focus.
 */
export function shouldHandleWorkspaceHotkey(input: {
  readonly target: unknown
  readonly overlayOpen: boolean
}): boolean {
  return !input.overlayOpen && !isTerminalFocusTarget(input.target)
}

/**
 * Registers the Workspace vertical's shortcuts while the Workspace is mounted (ADR 0001). Add project opens the
 * project dialog, or leaves it as it is when already open. New chat without a project makes the same selection as
 * the sidebar's New chat button: no Project, Task or Conversation. Neither fires while an overlay is open or a terminal has focus; the key is
 * only claimed once that guard passes, so a blocked press still reaches whatever owns it.
 */
export function useWorkspaceHotkeys(): void {
  const projectDialog = useWorkspaceProjectDialog()
  const updateNavigation = useAtomSet(updateWorkspaceNavigationAtom)

  useHotkeys(
    WORKSPACE_SHORTCUTS.map(def => ({
      hotkey: def.hotkey,
      callback: event => {
        if (!shouldHandleWorkspaceHotkey({ target: event.target, overlayOpen: isOverlayOpen(document) })) return
        event.preventDefault()
        switch (def.action) {
          case 'addProject':
            if (!projectDialog.isOpen) projectDialog.open()
            break
          case 'newChatWithoutProject':
            updateNavigation({ projectId: null, taskId: null, conversationId: null })
            break
          case 'overview':
          case 'sessions':
          case 'pullRequests':
          case 'spend':
          case 'optimize':
          case 'models':
          case 'compare':
          case 'coachSkills':
          case 'workspace':
          case 'settings':
          case 'refresh':
          case 'toggleSidebar':
          case 'commandPalette':
          case 'summonOrb':
            // Registered by their own owners (the app hotkeys, the sidebar toggle, the main process); the
            // workspace filter above never yields them. Listed so the switch stays exhaustive.
            break
        }
      },
      options: { meta: { name: def.label, description: def.action } },
    })),
    { preventDefault: false, stopPropagation: false },
  )
}
