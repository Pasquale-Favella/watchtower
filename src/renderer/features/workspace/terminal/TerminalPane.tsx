import '@xterm/xterm/css/xterm.css'

import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { isMac } from '@/renderer/features/workspace/platform-labels'
import { terminalRpcMessages } from '@/shared/rpc/terminal.js'
import { TERMINAL_DEFAULT_COLS, TERMINAL_DEFAULT_ROWS, type TerminalId } from '@/shared/schemas/terminal.js'
import type { TaskId } from '@/shared/schemas/workspace.js'

import { isTerminalDrawerShortcut } from './terminal-keys.js'
import { acceptTerminalFrame, type TerminalPaneStatus, type TerminalSessionEvent } from './terminal-storage.js'
import { isDarkDocument, readTerminalTheme } from './terminal-theme.js'
import { useTerminalSession } from './use-terminal-session.js'

interface PaneView {
  readonly status: TerminalPaneStatus
  readonly exitCode: number | null
  readonly message: string | null
}

const STATUS_LABEL: Record<Exclude<TerminalPaneStatus, 'running' | 'connecting'>, string> = {
  exited: '[process exited]',
  failed: 'Terminal unavailable.',
  ended: 'Terminal closed.',
}

/** Footer text for a pane that is not streaming. Running and connecting panes show none. */
function statusLabel(view: PaneView): string {
  switch (view.status) {
    case 'exited':
      return view.exitCode === null ? STATUS_LABEL.exited : `${STATUS_LABEL.exited} code ${view.exitCode}`
    case 'failed':
      return view.message ?? STATUS_LABEL.failed
    case 'ended':
      return STATUS_LABEL.ended
    default:
      return ''
  }
}

export interface TerminalPaneProps {
  readonly taskId: TaskId
  readonly terminalId: TerminalId
  readonly active: boolean
  readonly onStatusChange: (terminalId: TerminalId, status: TerminalPaneStatus) => void
}

/** One xterm instance bound to one session. Inactive panes stay mounted so their output keeps flowing. */
export function TerminalPane({ taskId, terminalId, active, onStatusChange }: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const sinkRef = useRef<(event: TerminalSessionEvent) => void>(() => undefined)
  const runningRef = useRef(false)
  const lastSequenceRef = useRef<number | null>(null)
  const sentSizeRef = useRef<{ readonly cols: number; readonly rows: number } | null>(null)
  const [view, setView] = useState<PaneView>({ status: 'connecting', exitCode: null, message: null })

  const session = useTerminalSession(taskId, terminalId, event => sinkRef.current(event))

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const root = document.documentElement
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 2_000,
      theme: readTerminalTheme(root, isDarkDocument(root)),
      // OSC 8 hyperlinks take the same external-open path as plain URLs, which accepts only http(s).
      linkHandler: {
        activate: (event, uri) => {
          event.preventDefault()
          session.openLink(uri)
        },
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault()
        session.openLink(uri)
      }),
    )
    term.open(host)
    termRef.current = term
    // The drawer owns Mod+J; xterm must not turn it into a line feed for the shell.
    term.attachCustomKeyEventHandler(event => !isTerminalDrawerShortcut(event, isMac))

    const syncSize = () => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      fit.fit()
      if (!runningRef.current) return
      const last = sentSizeRef.current
      if (last && last.cols === term.cols && last.rows === term.rows) return
      sentSizeRef.current = { cols: term.cols, rows: term.rows }
      session.resize(term.cols, term.rows)
    }

    sinkRef.current = event => {
      if (event._tag === 'failed') {
        runningRef.current = false
        setView({ status: 'failed', exitCode: null, message: event.message })
        return
      }
      if (event._tag === 'ended') {
        runningRef.current = false
        setView({ status: 'ended', exitCode: null, message: null })
        return
      }
      if (!acceptTerminalFrame(lastSequenceRef.current, event)) return
      lastSequenceRef.current = event.sequence
      switch (event._tag) {
        case 'snapshot':
          term.reset()
          term.write(event.data)
          runningRef.current = event.status === 'running'
          sentSizeRef.current = { cols: event.cols, rows: event.rows }
          setView({ status: event.status, exitCode: event.exitCode, message: null })
          syncSize()
          return
        case 'output':
          term.write(event.data)
          return
        case 'exited':
          runningRef.current = false
          setView({ status: 'exited', exitCode: event.exitCode, message: null })
          return
        case 'restarted':
          term.reset()
          runningRef.current = true
          sentSizeRef.current = { cols: event.cols, rows: event.rows }
          setView({ status: 'running', exitCode: null, message: null })
          syncSize()
          return
      }
    }

    const dataSubscription = term.onData(data => {
      if (runningRef.current) session.input(data)
    })
    const resizeObserver = new ResizeObserver(() => syncSize())
    resizeObserver.observe(host)
    const themeObserver = new MutationObserver(() => {
      term.options.theme = readTerminalTheme(root, isDarkDocument(root))
    })
    themeObserver.observe(root, { attributes: true, attributeFilter: ['class'] })

    return () => {
      sinkRef.current = () => undefined
      resizeObserver.disconnect()
      themeObserver.disconnect()
      dataSubscription.dispose()
      termRef.current = null
      term.dispose()
    }
  }, [session])

  useEffect(() => {
    onStatusChange(terminalId, view.status)
  }, [onStatusChange, terminalId, view.status])

  useEffect(() => {
    if (active && view.status === 'running') termRef.current?.focus()
  }, [active, view.status])

  const restart = () => {
    const term = termRef.current
    session
      .restart(term?.cols ?? TERMINAL_DEFAULT_COLS, term?.rows ?? TERMINAL_DEFAULT_ROWS)
      .catch(() => setView({ status: 'failed', exitCode: null, message: terminalRpcMessages.failed }))
  }

  const showFooter = view.status !== 'running' && view.status !== 'connecting'
  const label = statusLabel(view)

  return (
    <div hidden={!active} className="absolute inset-0 flex min-h-0 flex-col">
      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-2 pt-1.5 pb-1" />
      {showFooter ? (
        <div
          role="status"
          className="border-border bg-card text-muted-foreground flex h-8 shrink-0 items-center justify-between gap-2 border-t px-3 text-[11.5px]"
        >
          <span className="truncate font-mono">{label}</span>
          {view.status === 'exited' ? (
            <Button type="button" variant="outline" size="xs" className="h-6 text-[11px]" onClick={restart}>
              Restart
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
