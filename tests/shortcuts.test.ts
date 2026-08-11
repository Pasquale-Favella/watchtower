import { describe, expect, it } from 'vitest'
import {
  SHORTCUTS,
  NAV_SECTIONS,
  NUMBERED_SECTION_SHORTCUTS,
  shortcutForAction,
  displayShortcut,
  displayShortcutForAction,
  sectionsRangeLabel
} from '../src/renderer/src/app/shortcuts.js'

describe('shortcut registry', () => {
  it('maps Mod+1–Mod+N to the numbered sections in nav order', () => {
    const numbered = NAV_SECTIONS.filter(section => section !== 'settings')
    numbered.forEach((section, i) => {
      expect(shortcutForAction(section)?.hotkey).toBe(`Mod+${i + 1}`)
    })
  })

  it('maps settings to Mod+, and refresh/toggle-sidebar to Mod+R/Mod+B', () => {
    expect(shortcutForAction('settings')?.hotkey).toBe('Mod+,')
    expect(shortcutForAction('refresh')?.hotkey).toBe('Mod+R')
    expect(shortcutForAction('toggleSidebar')?.hotkey).toBe('Mod+B')
  })

  it('registers nothing for digits beyond the numbered sections (Mod+9/Mod+10 no-op)', () => {
    const hotkeys = new Set(SHORTCUTS.map(def => def.hotkey))
    expect(hotkeys.has('Mod+9')).toBe(false)
    expect(hotkeys.has('Mod+10')).toBe(false)
    expect(NUMBERED_SECTION_SHORTCUTS).toHaveLength(NAV_SECTIONS.length - 1)
  })

  it('declares exactly one definition per action and per key (no duplicates)', () => {
    const actions = SHORTCUTS.map(def => def.action)
    expect(new Set(actions).size).toBe(actions.length)
    const hotkeys = SHORTCUTS.map(def => def.hotkey)
    expect(new Set(hotkeys).size).toBe(hotkeys.length)
  })

  it('renders platform-correct badges (⌘ on mac, Ctrl on Windows/Linux)', () => {
    expect(displayShortcut('Mod+1', 'mac')).toBe('⌘1')
    expect(displayShortcut('Mod+1', 'windows')).toBe('Ctrl+1')
    expect(displayShortcut('Mod+1', 'linux')).toBe('Ctrl+1')
    expect(displayShortcut('Mod+,', 'mac')).toBe('⌘,')
    expect(displayShortcut('Mod+R', 'mac')).toBe('⌘R')
    expect(displayShortcutForAction('settings', 'windows')).toBe('Ctrl+,')
    expect(displayShortcutForAction('refresh', 'windows')).toBe('Ctrl+R')
  })

  it('derives the footer range from the registry, per platform', () => {
    expect(sectionsRangeLabel('mac')).toBe('⌘1–⌘8')
    expect(sectionsRangeLabel('windows')).toBe('Ctrl+1–Ctrl+8')
    expect(sectionsRangeLabel('linux')).toBe('Ctrl+1–Ctrl+8')
  })
})
