import { useAtomSet } from '@effect/atom-react'
import { useCallback, useState } from 'react'

import type { TerminalId } from '@/shared/schemas/terminal.js'
import type { TaskId } from '@/shared/schemas/workspace.js'

import { closeTerminalAtom } from './terminal-atoms.js'
import {
  browserTerminalStorage,
  initialTerminalTabs,
  nextTerminalId,
  readTerminalDrawerState,
  TERMINAL_DRAWER_DEFAULT_HEIGHT,
  type TerminalDrawerPatch,
  type TerminalPaneStatus,
  writeTerminalDrawerEntry,
} from './terminal-storage.js'

interface TabState {
  readonly terminals: ReadonlyArray<TerminalId>
  readonly active: TerminalId | null
  readonly height: number
}

function readTabState(taskId: TaskId): TabState {
  const entry = readTerminalDrawerState(browserTerminalStorage())[taskId]
  return { ...initialTerminalTabs(entry), height: entry?.height ?? TERMINAL_DRAWER_DEFAULT_HEIGHT }
}

/** Tab list, active tab, height and reported statuses for one Task's drawer. Every change is persisted for that Task. */
export function useTerminalTabs(taskId: TaskId) {
  const closeTerminal = useAtomSet(closeTerminalAtom, { mode: 'promise' })
  const [state, setState] = useState<TabState>(() => readTabState(taskId))
  const [statuses, setStatuses] = useState<Partial<Record<TerminalId, TerminalPaneStatus>>>({})

  const persist = useCallback(
    (patch: TerminalDrawerPatch) => {
      writeTerminalDrawerEntry(browserTerminalStorage(), taskId, patch)
    },
    [taskId],
  )

  const commitTabs = useCallback(
    (next: { readonly terminals: ReadonlyArray<TerminalId>; readonly active: TerminalId | null }) => {
      setState(current => ({ ...current, ...next }))
      persist({ terminals: [...next.terminals], activeTerminal: next.active })
    },
    [persist],
  )

  const select = useCallback(
    (id: TerminalId) => {
      setState(current => ({ ...current, active: id }))
      persist({ activeTerminal: id })
    },
    [persist],
  )

  /** Adds the next free tab. Its pane opens the session when it mounts. */
  const create = useCallback((): TerminalId | null => {
    const id = nextTerminalId(state.terminals)
    if (id === null) return null
    commitTabs({ terminals: [...state.terminals, id], active: id })
    return id
  }, [commitTabs, state.terminals])

  /** Removes the tab, then ends its session. The pane unmounts first, so nothing reattaches to it. */
  const close = useCallback(
    (id: TerminalId) => {
      const index = state.terminals.indexOf(id)
      if (index < 0) return
      const remaining = state.terminals.filter(terminal => terminal !== id)
      const active = state.active === id ? (remaining[Math.min(index, remaining.length - 1)] ?? null) : state.active
      commitTabs({ terminals: remaining, active })
      void closeTerminal({ taskId, terminalId: id }).catch(() => undefined)
    },
    [closeTerminal, commitTabs, state.active, state.terminals, taskId],
  )

  /** Live drag feedback; nothing is stored until the drag ends. */
  const previewHeight = useCallback((height: number) => {
    setState(current => ({ ...current, height }))
  }, [])

  const commitHeight = useCallback(
    (height: number) => {
      setState(current => ({ ...current, height }))
      persist({ height })
    },
    [persist],
  )

  const reportStatus = useCallback((id: TerminalId, status: TerminalPaneStatus) => {
    setStatuses(current => (current[id] === status ? current : { ...current, [id]: status }))
  }, [])

  return {
    terminals: state.terminals,
    active: state.active,
    height: state.height,
    statuses,
    select,
    create,
    close,
    previewHeight,
    commitHeight,
    reportStatus,
  }
}
