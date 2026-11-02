import { useCallback, useEffect, useMemo, useState } from 'react'

import { isMac } from '@/renderer/features/workspace/platform-labels.js'
import type { TaskId } from '@/shared/schemas/workspace.js'

import { isTerminalDrawerShortcut, isTextEntryOutsideTerminal } from './terminal-keys.js'
import { browserTerminalStorage, readTerminalDrawerState, writeTerminalDrawerEntry } from './terminal-storage.js'

/** Open state for one Task's terminal drawer, persisted per Task, with the Mod+J toggle. */
export function useTerminalDrawer(taskId: TaskId) {
  const [local, setLocal] = useState<{ readonly taskId: TaskId; readonly open: boolean } | null>(null)
  const persisted = useMemo(() => readTerminalDrawerState(browserTerminalStorage())[taskId]?.open ?? false, [taskId])
  const open = local?.taskId === taskId ? local.open : persisted

  const setOpen = useCallback(
    (next: boolean) => {
      writeTerminalDrawerEntry(browserTerminalStorage(), taskId, { open: next })
      setLocal({ taskId, open: next })
    },
    [taskId],
  )
  const toggle = useCallback(() => setOpen(!open), [open, setOpen])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTerminalDrawerShortcut(event, isMac) || isTextEntryOutsideTerminal(event.target)) return
      event.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggle])

  return { open, toggle, setOpen }
}
