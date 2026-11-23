import { detectPlatform, formatForDisplay, type Hotkey, type Modifier } from '@tanstack/react-hotkeys'

import { SHORTCUTS } from '@/shared/lib/shortcuts.js'
import type { Section } from '@/shared/schemas/navigation.js'
import type { Platform, ShortcutAction, ShortcutDef } from '@/shared/schemas/renderer.js'
export type { Platform, Section, ShortcutAction, ShortcutDef }

/** Analytics sections in sidebar/nav order. Workspace is a separate app vertical. */
export const NAV_SECTIONS: readonly Section[] = [
  'overview',
  'sessions',
  'pullRequests',
  'spend',
  'optimize',
  'models',
  'compare',
  'coachSkills',
  'settings',
]

/** The shortcut table (ADR 0001) is declared once in shared/lib/shortcuts.ts
 * — shared because the main process registers its `global` entries — and is
 * this registry's single source: registration and every rendering read it. */
export { SHORTCUTS }

const byAction = new Map<ShortcutAction, ShortcutDef>(SHORTCUTS.map(def => [def.action, def]))

export function shortcutForAction(action: ShortcutAction): ShortcutDef | undefined {
  return byAction.get(action)
}

/** Shortcut actions without a numbered section jump — excluded from the
 * numbered badges and the footer range. */
const NON_NUMBERED: ReadonlySet<ShortcutAction> = new Set([
  'settings',
  'refresh',
  'toggleSidebar',
  'commandPalette',
  'summonOrb',
  'addProject',
  'newChatWithoutProject',
])

/** The numbered section shortcuts (settings excluded): `Mod+1`..`Mod+N` in nav order. */
export const NUMBERED_SECTION_SHORTCUTS: readonly ShortcutDef[] = SHORTCUTS.filter(def => !NON_NUMBERED.has(def.action))

/** Platform-aware shortcut badge: `⌘1` on mac, `Ctrl+1` on Windows/Linux. A lone modifier (`Mod`) renders as `⌘` or `Ctrl`. */
export function displayShortcut(hotkey: Hotkey | Modifier, platform?: Platform): string {
  const os = platform ?? detectPlatform()
  return formatForDisplay(hotkey, os === 'mac' ? { platform: os, separatorToken: '' } : { platform: os })
}

/** Like `displayShortcut`, but spells key names out off mac (`Ctrl+Enter`, not `Ctrl+↵`); mac keeps `⌘↵`.
 * Only for named keys: punctuation spells out too (`Comma`). */
export function displayShortcutText(hotkey: Hotkey | Modifier, platform?: Platform): string {
  const os = platform ?? detectPlatform()
  return os === 'mac' ? displayShortcut(hotkey, os) : formatForDisplay(hotkey, { platform: os, useSymbols: false })
}

export function displayShortcutForAction(action: ShortcutAction, platform?: Platform): string | undefined {
  const def = byAction.get(action)
  return def ? displayShortcut(def.hotkey, platform) : undefined
}

/** The footer's numbered-section range, e.g. `⌘1–⌘8` on mac, `Ctrl+1–Ctrl+8` elsewhere. */
export function sectionsRangeLabel(platform?: Platform): string {
  const first = NUMBERED_SECTION_SHORTCUTS[0]
  const last = NUMBERED_SECTION_SHORTCUTS[NUMBERED_SECTION_SHORTCUTS.length - 1]
  return first && last ? `${displayShortcut(first.hotkey, platform)}–${displayShortcut(last.hotkey, platform)}` : ''
}
