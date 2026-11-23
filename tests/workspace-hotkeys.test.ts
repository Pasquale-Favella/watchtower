import { describe, expect, it } from 'vitest'

import { displayShortcutForAction, shortcutForAction, SHORTCUTS } from '../src/renderer/app/shortcuts.js'
import {
  isOverlayOpen,
  OPEN_OVERLAY_SELECTOR,
  shouldHandleWorkspaceHotkey,
  WORKSPACE_SHORTCUTS,
} from '../src/renderer/features/workspace/use-workspace-hotkeys.js'

describe('workspace hotkeys', () => {
  it('registers exactly the workspace-scoped entries from the shortcut table', () => {
    expect(WORKSPACE_SHORTCUTS).toEqual(SHORTCUTS.filter(def => def.scope === 'workspace'))
    expect(WORKSPACE_SHORTCUTS.map(def => def.action).sort()).toEqual(['addProject', 'newChatWithoutProject'])
  })

  it('keeps workspace entries out of the app hotkeys, which register only unscoped actions', () => {
    // use-app-hotkeys registers entries whose scope is undefined; workspace entries must carry a scope to be skipped.
    for (const def of WORKSPACE_SHORTCUTS) {
      expect(def.scope).toBe('workspace')
      expect(shortcutForAction(def.action)).toBe(def)
    }
    expect(SHORTCUTS.filter(def => def.scope === undefined).some(def => def.action === 'addProject')).toBe(false)
    expect(SHORTCUTS.filter(def => def.scope === undefined).some(def => def.action === 'newChatWithoutProject')).toBe(
      false,
    )
  })

  it('labels the workspace shortcuts for the discoverability badges', () => {
    expect(displayShortcutForAction('addProject', 'windows')).toBe('Ctrl+O')
    expect(displayShortcutForAction('addProject', 'mac')).toBe('⌘O')
    expect(displayShortcutForAction('newChatWithoutProject', 'windows')).toBe('Ctrl+Alt+N')
  })

  describe('guard', () => {
    const terminalTarget = { closest: (selector: string) => (selector === '[data-terminal-owner]' ? {} : null) }
    const plainTarget = { closest: () => null }

    it('detects an open dialog, alert dialog or menu but not a closing one', () => {
      const root = (open: boolean) => ({
        querySelector: (selector: string) => (open && selector === OPEN_OVERLAY_SELECTOR ? {} : null),
      })
      expect(isOverlayOpen(root(true))).toBe(true)
      expect(isOverlayOpen(root(false))).toBe(false)
      for (const role of ['dialog', 'alertdialog', 'menu']) {
        expect(OPEN_OVERLAY_SELECTOR).toContain(`[role="${role}"]:not([data-closed])`)
      }
    })

    it('acts only with no overlay open and focus outside a terminal', () => {
      expect(shouldHandleWorkspaceHotkey({ target: plainTarget, overlayOpen: false })).toBe(true)
      expect(shouldHandleWorkspaceHotkey({ target: null, overlayOpen: false })).toBe(true)
      expect(shouldHandleWorkspaceHotkey({ target: plainTarget, overlayOpen: true })).toBe(false)
      expect(shouldHandleWorkspaceHotkey({ target: terminalTarget, overlayOpen: false })).toBe(false)
      expect(shouldHandleWorkspaceHotkey({ target: terminalTarget, overlayOpen: true })).toBe(false)
    })
  })
})
