import { RegistryContext, useAtomSet } from '@effect/atom-react'
import { useContext, useEffect, useMemo, useRef } from 'react'

import { openExternalAtom } from '@/renderer/shared/lib/native-capabilities.js'
import { TERMINAL_WRITE_MAX_CHARS, type TerminalId } from '@/shared/schemas/terminal.js'
import type { TaskId } from '@/shared/schemas/workspace.js'

import {
  restartTerminalAtom,
  sendTerminalCommand,
  subscribeTerminalSession,
  terminalSessionAtom,
} from './terminal-atoms.js'
import { terminalInputChunks, type TerminalSessionEvent } from './terminal-storage.js'

export interface TerminalSessionController {
  /** Sends keystrokes or pasted text, split into server-sized writes. */
  readonly input: (data: string) => void
  readonly resize: (cols: number, rows: number) => void
  readonly restart: (cols: number, rows: number) => Promise<unknown>
  readonly openLink: (url: string) => void
}

/**
 * Attaches one pane to its Task-scoped session. Mounting opens or reattaches the session; unmounting
 * detaches it while the process keeps running. Input and resize are ordered per session.
 */
export function useTerminalSession(
  taskId: TaskId,
  terminalId: TerminalId,
  onEvent: (event: TerminalSessionEvent) => void,
): TerminalSessionController {
  const registry = useContext(RegistryContext)
  const listenerRef = useRef(onEvent)
  // Setters from useAtomSet change identity on every render. They are read through refs so the
  // controller, and the pane's xterm built on it, stays stable for the life of the session.
  const restartTerminal = useAtomSet(restartTerminalAtom, { mode: 'promise' })
  const openExternal = useAtomSet(openExternalAtom)
  const restartRef = useRef(restartTerminal)
  const openExternalRef = useRef(openExternal)

  useEffect(() => {
    listenerRef.current = onEvent
    restartRef.current = restartTerminal
    openExternalRef.current = openExternal
  })

  useEffect(() => {
    const unsubscribe = subscribeTerminalSession(taskId, terminalId, event => listenerRef.current(event))
    const unmount = registry.mount(terminalSessionAtom(taskId, terminalId))
    return () => {
      unmount()
      unsubscribe()
    }
  }, [registry, taskId, terminalId])

  return useMemo<TerminalSessionController>(
    () => ({
      input: data => {
        for (const chunk of terminalInputChunks(data, TERMINAL_WRITE_MAX_CHARS)) {
          sendTerminalCommand(taskId, terminalId, { _tag: 'write', data: chunk })
        }
      },
      resize: (cols, rows) => {
        sendTerminalCommand(taskId, terminalId, { _tag: 'resize', cols, rows })
      },
      restart: (cols, rows) => restartRef.current({ taskId, terminalId, cols, rows }),
      openLink: url => openExternalRef.current(url),
    }),
    [taskId, terminalId],
  )
}
