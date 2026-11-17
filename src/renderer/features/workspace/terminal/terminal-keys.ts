type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>

/** Mod+J toggles the drawer; the terminal itself never receives it, so it cannot send a line feed to the shell. */
export function isTerminalDrawerShortcut(event: ShortcutEvent, isMac: boolean): boolean {
  const modifier = isMac ? event.metaKey : event.ctrlKey
  return modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j'
}

export type TerminalAction = 'split' | 'splitVertical' | 'new'

/**
 * Drawer actions while a terminal has focus. macOS uses ⌘D, ⌘⇧D and ⌘N. Elsewhere Ctrl+D and Ctrl+N
 * belong to the shell (end of input, next history entry), so the bindings add Shift: Ctrl+Shift+D,
 * Ctrl+Shift+E and Ctrl+Shift+N.
 */
export function terminalActionShortcut(event: ShortcutEvent, isMac: boolean): TerminalAction | null {
  if (event.altKey) return null
  const key = event.key.toLowerCase()
  if (isMac) {
    if (!event.metaKey || event.ctrlKey) return null
    if (key === 'd') return event.shiftKey ? 'splitVertical' : 'split'
    if (key === 'n' && !event.shiftKey) return 'new'
    return null
  }
  if (!event.ctrlKey || event.metaKey || !event.shiftKey) return null
  if (key === 'd') return 'split'
  if (key === 'e') return 'splitVertical'
  if (key === 'n') return 'new'
  return null
}

const ACTION_LABELS: Record<TerminalAction, { readonly mac: string; readonly other: string }> = {
  split: { mac: '⌘D', other: 'Ctrl+Shift+D' },
  splitVertical: { mac: '⇧⌘D', other: 'Ctrl+Shift+E' },
  new: { mac: '⌘N', other: 'Ctrl+Shift+N' },
}

export function terminalShortcutLabel(action: TerminalAction | 'toggle', isMac: boolean): string {
  if (action === 'toggle') return isMac ? '⌘J' : 'Ctrl+J'
  const labels = ACTION_LABELS[action]
  return isMac ? labels.mac : labels.other
}

/** True when the event target sits inside a terminal surface, where the shell owns plain shortcuts. */
export function isTerminalFocusTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object' || !('closest' in target)) return false
  const element = target as { readonly closest?: (selector: string) => unknown }
  return typeof element.closest === 'function' && Boolean(element.closest('[data-terminal-owner]'))
}

/** True when focus is in a text field that is not the terminal, so the shortcut must not steal it. */
export function isTextEntryOutsideTerminal(target: unknown): boolean {
  if (!target || typeof target !== 'object' || !('tagName' in target)) return false
  const element = target as Partial<HTMLElement> & { readonly tagName: string }
  if (typeof element.closest === 'function' && element.closest('.xterm')) return false
  const tag = element.tagName.toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable === true
}

export function isTerminalCloseShortcut(event: ShortcutEvent, isMac: boolean): boolean {
  return (
    (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === 'w'
  )
}

/** Translates editor-style cursor and clear bindings into shell control sequences. */
export function terminalInputShortcut(event: ShortcutEvent, isMac: boolean): string | null {
  if (event.shiftKey) return null
  const key = event.key.toLowerCase()
  if (key === 'l' && event.ctrlKey && !event.metaKey && !event.altKey) return '\u000c'
  if (isMac && event.metaKey && !event.ctrlKey && !event.altKey) {
    if (key === 'k') return '\u000c'
    if (key === 'backspace') return '\u0015'
    if (key === 'arrowleft') return '\u0001'
    if (key === 'arrowright') return '\u0005'
  }
  if (event.altKey && !event.ctrlKey && !event.metaKey) {
    if (key === 'arrowleft') return '\u001bb'
    if (key === 'arrowright') return '\u001bf'
  }
  return null
}
