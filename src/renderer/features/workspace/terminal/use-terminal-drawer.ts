import { RegistryContext, useAtomValue } from '@effect/atom-react'
import { useCallback, useContext, useEffect } from 'react'

import { isMac } from '@/renderer/features/workspace/platform-labels.js'
import { type TerminalOwner, terminalOwnerKey } from '@/shared/schemas/terminal.js'

import { isTerminalDrawerShortcut } from './terminal-keys.js'
import { hydrateTerminalLayouts, terminalLayoutsAtom, updateTerminalLayoutAtom } from './terminal-layout-atoms.js'

/** Mod+J toggles the drawer from the composer too; the focused shell never receives it. */
export function useTerminalDrawer(owner: TerminalOwner) {
  const registry = useContext(RegistryContext)
  const key = terminalOwnerKey(owner)
  const entries = useAtomValue(terminalLayoutsAtom)
  const open = entries[key]?.open ?? false
  useEffect(() => hydrateTerminalLayouts(registry), [registry])
  const setOpen = useCallback(
    (next: boolean) => registry.set(updateTerminalLayoutAtom, { ownerKey: key, action: { kind: 'open', open: next } }),
    [key, registry],
  )
  const toggle = useCallback(() => setOpen(!open), [open, setOpen])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTerminalDrawerShortcut(event, isMac) || event.repeat) return
      event.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggle])
  return { open, toggle, setOpen }
}
