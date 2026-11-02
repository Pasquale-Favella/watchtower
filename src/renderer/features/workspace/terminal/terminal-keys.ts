/** Mod+J toggles the drawer; the terminal itself never receives it, so it cannot send a line feed to the shell. */
export function isTerminalDrawerShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  isMac: boolean,
): boolean {
  const modifier = isMac ? event.metaKey : event.ctrlKey
  return modifier && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'j'
}

/** True when focus is in a text field that is not the terminal, so the shortcut must not steal it. */
export function isTextEntryOutsideTerminal(target: unknown): boolean {
  if (!target || typeof target !== 'object' || !('tagName' in target)) return false
  const element = target as Partial<HTMLElement> & { readonly tagName: string }
  if (typeof element.closest === 'function' && element.closest('.xterm')) return false
  const tag = element.tagName.toUpperCase()
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || element.isContentEditable === true
}
