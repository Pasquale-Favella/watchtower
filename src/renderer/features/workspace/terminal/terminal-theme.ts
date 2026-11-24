import type { ITheme } from '@xterm/xterm'

const LIGHT_ANSI: ITheme = {
  black: '#181b20',
  red: '#b42318',
  green: '#15803d',
  yellow: '#a16207',
  blue: '#1d4ed8',
  magenta: '#a21caf',
  cyan: '#0e7490',
  white: '#d8dce3',
  brightBlack: '#697181',
  brightRed: '#dc2626',
  brightGreen: '#16a34a',
  brightYellow: '#ca8a04',
  brightBlue: '#2563eb',
  brightMagenta: '#c026d3',
  brightCyan: '#0891b2',
  brightWhite: '#f8fafc',
}

const DARK_ANSI: ITheme = {
  black: '#0e1013',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#facc15',
  blue: '#60a5fa',
  magenta: '#e879f9',
  cyan: '#22d3ee',
  white: '#cbd5e1',
  brightBlack: '#64748b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#f0abfc',
  brightCyan: '#67e8f9',
  brightWhite: '#f8fafc',
}

/** Reads the drawer colours from the app's theme tokens so the terminal matches light and dark mode. */
export function readTerminalTheme(root: HTMLElement, dark: boolean): ITheme {
  const style = getComputedStyle(root)
  const token = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  const background = token('--card', dark ? '#16181d' : '#ffffff')
  return {
    ...(dark ? DARK_ANSI : LIGHT_ANSI),
    background,
    foreground: token('--foreground', dark ? '#e8eaee' : '#181b20'),
    cursor: token('--primary', dark ? '#06b6d4' : '#007595'),
    cursorAccent: background,
    selectionBackground: token('--muted', dark ? '#20242b' : '#f1f2f4'),
  }
}

export function isDarkDocument(root: HTMLElement): boolean {
  return root.classList.contains('dark')
}
