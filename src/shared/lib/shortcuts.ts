import type { Hotkey } from '@tanstack/react-hotkeys'

import type { ShortcutDef } from '../schemas/renderer.js'

/**
 * The shortcut table (ADR 0001) — every shortcut, declared once. The renderer's
 * registry module (`app/shortcuts.ts`) exposes it with the display helpers; it
 * lives in shared/ because one entry is OS-global: the main process registers
 * `scope: 'global'` shortcuts with Electron's `globalShortcut`, so they keep
 * working while every window is hidden. `Mod` resolves to ⌘ on macOS and
 * Ctrl on Windows/Linux.
 */
export const SHORTCUTS: readonly ShortcutDef[] = [
  { action: 'overview', hotkey: 'Mod+1', label: 'Overview' },
  { action: 'sessions', hotkey: 'Mod+2', label: 'Sessions' },
  { action: 'pullRequests', hotkey: 'Mod+3', label: 'Pull requests' },
  { action: 'spend', hotkey: 'Mod+4', label: 'Spend' },
  { action: 'optimize', hotkey: 'Mod+5', label: 'Optimize' },
  { action: 'models', hotkey: 'Mod+6', label: 'Models' },
  { action: 'compare', hotkey: 'Mod+7', label: 'Compare' },
  { action: 'coachSkills', hotkey: 'Mod+8', label: 'Coach & Skills' },
  { action: 'settings', hotkey: 'Mod+,', label: 'Settings' },
  { action: 'refresh', hotkey: 'Mod+R', label: 'Refresh' },
  { action: 'toggleSidebar', hotkey: 'Mod+B', label: 'Toggle sidebar' },
  { action: 'commandPalette', hotkey: 'Mod+K', label: 'Command palette' },
  { action: 'summonOrb', hotkey: 'Mod+Alt+O', label: 'Summon Watchtower', scope: 'global' },
]

/** A registry hotkey as an Electron accelerator (`Mod` → `CommandOrControl`). */
export function acceleratorFor(hotkey: Hotkey): string {
  return hotkey
    .split('+')
    .map(part => (part === 'Mod' ? 'CommandOrControl' : part))
    .join('+')
}
