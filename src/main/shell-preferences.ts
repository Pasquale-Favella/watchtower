import { readFileSync, writeFileSync } from 'fs'

import type { Point } from './orb-policy.js'

/** The background shell's persisted toggles (`userData/shell-preferences.json`). */
export interface ShellPreferences {
  /** Close hides the window and keeps the app in the tray. */
  runInBackground: boolean
  /** Show the floating orb while the main window is away. */
  orbEnabled: boolean
  /** The orb's last anchor; null = the default corner. */
  orbPosition: Point | null
}

const DEFAULTS: ShellPreferences = { runInBackground: true, orbEnabled: true, orbPosition: null }

/** Reads the file leniently: a missing or malformed field falls back to its
 * default rather than discarding the rest. */
export function loadShellPreferences(file: string): ShellPreferences {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ShellPreferences>
    const position = raw.orbPosition
    return {
      runInBackground: typeof raw.runInBackground === 'boolean' ? raw.runInBackground : DEFAULTS.runInBackground,
      orbEnabled: typeof raw.orbEnabled === 'boolean' ? raw.orbEnabled : DEFAULTS.orbEnabled,
      orbPosition:
        position && Number.isFinite(position.x) && Number.isFinite(position.y)
          ? { x: Math.round(position.x), y: Math.round(position.y) }
          : null,
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveShellPreferences(file: string, prefs: ShellPreferences): void {
  try {
    writeFileSync(file, JSON.stringify(prefs, null, 2), 'utf8')
  } catch {
    /* preferences are a convenience — never break the shell over them */
  }
}
