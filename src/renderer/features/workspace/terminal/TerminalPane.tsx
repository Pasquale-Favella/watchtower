import '@xterm/xterm/css/xterm.css'

import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { Terminal } from '@xterm/xterm'
import { type CSSProperties, useEffect, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { ContextMenu, ContextMenuTrigger } from '@/renderer/components/ui/context-menu'
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from '@/renderer/components/ui/dropdown-menu'
import { isMac } from '@/renderer/features/workspace/platform-labels'
import { cn } from '@/renderer/shared/lib/utils'
import { terminalRpcMessages } from '@/shared/rpc/terminal.js'
import {
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
  type TerminalId,
  type TerminalOwner,
} from '@/shared/schemas/terminal.js'
import type { TaskId } from '@/shared/schemas/workspace.js'

import {
  isTerminalCloseShortcut,
  isTerminalDrawerShortcut,
  terminalActionShortcut,
  terminalInputShortcut,
} from './terminal-keys.js'
import { bindTerminalOutput } from './terminal-output.js'
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

/** A selected range of terminal output, with 1-based buffer line numbers. */
export interface TerminalExcerpt {
  readonly terminalId: TerminalId
  readonly lineStart: number
  readonly lineEnd: number
  readonly text: string
}

export interface TerminalPaneProps {
  readonly taskId?: TaskId | undefined
  readonly target?: TerminalOwner | undefined
  readonly onOpenLink?: ((url: string) => void) | undefined
  readonly terminalId: TerminalId
  readonly label: string
  /** Shown in the drawer's current group. Hidden panes stay mounted so their output keeps flowing. */
  readonly visible: boolean
  readonly focused: boolean
  readonly className?: string | undefined
  readonly style?: CSSProperties | undefined
  readonly onFocusRequest: (terminalId: TerminalId) => void
  readonly onStatusChange: (terminalId: TerminalId, status: TerminalPaneStatus) => void
  /** Omitted when there is no Conversation to add the excerpt to. */
  readonly onAddToChat?: ((excerpt: TerminalExcerpt) => void) | undefined
}

/** One xterm instance bound to one session. */
export function TerminalPane({
  taskId,
  target,
  onOpenLink,
  terminalId,
  label,
  visible,
  focused,
  className,
  style,
  onFocusRequest,
  onStatusChange,
  onAddToChat,
}: TerminalPaneProps) {
  const linkRef = useRef(onOpenLink)
  useEffect(() => {
    linkRef.current = onOpenLink
  }, [onOpenLink])
  const owner = target ?? taskId
  if (!owner) throw new Error('A terminal owner is required')
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const sinkRef = useRef<(event: TerminalSessionEvent) => void>(() => undefined)
  const runningRef = useRef(false)
  const lastSequenceRef = useRef<number | null>(null)
  const sentSizeRef = useRef<{ readonly cols: number; readonly rows: number } | null>(null)
  const [view, setView] = useState<PaneView>({ status: 'connecting', exitCode: null, message: null })
  const [menuHasSelection, setMenuHasSelection] = useState(false)

  const session = useTerminalSession(owner, terminalId, event => sinkRef.current(event))

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
          const open = linkRef.current ?? session.openLink
          open(uri)
        },
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault()
        const open = linkRef.current ?? session.openLink
        open(uri)
      }),
    )
    term.open(host)
    termRef.current = term
    const output = bindTerminalOutput(term, data => {
      if (runningRef.current) session.input(data)
    })
    // The drawer owns Mod+J and its split/new shortcuts; xterm must not send them to the shell.
    term.attachCustomKeyEventHandler(event => {
      if (
        isTerminalDrawerShortcut(event, isMac) ||
        isTerminalCloseShortcut(event, isMac) ||
        terminalActionShortcut(event, isMac) !== null
      )
        return false
      if (event.type !== 'keydown') return true
      const data = terminalInputShortcut(event, isMac)
      if (data !== null) {
        event.preventDefault()
        event.stopPropagation()
        session.input(data)
        return false
      }
      const clipboardModifier = isMac
        ? event.metaKey && !event.ctrlKey
        : event.ctrlKey && event.shiftKey && !event.metaKey
      if (clipboardModifier && !event.altKey && event.key.toLowerCase() === 'c' && term.hasSelection()) {
        event.preventDefault()
        void navigator.clipboard.writeText(term.getSelection()).catch(() => undefined)
        return false
      }
      if (clipboardModifier && !event.altKey && event.key.toLowerCase() === 'v') {
        event.preventDefault()
        void navigator.clipboard
          .readText()
          .then(text => term.paste(text))
          .catch(() => undefined)
        return false
      }
      return true
    })

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
          output.restoreSnapshot(event.data)
          runningRef.current = event.status === 'running'
          sentSizeRef.current = { cols: event.cols, rows: event.rows }
          setView({ status: event.status, exitCode: event.exitCode, message: null })
          syncSize()
          return
        case 'output':
          output.append(event.data)
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
      output.dispose()
      termRef.current = null
      term.dispose()
    }
  }, [session])

  useEffect(() => {
    onStatusChange(terminalId, view.status)
  }, [onStatusChange, terminalId, view.status])

  useEffect(() => {
    if (visible && focused && view.status === 'running') termRef.current?.focus()
  }, [focused, visible, view.status])

  const restart = () => {
    const term = termRef.current
    session
      .restart(term?.cols ?? TERMINAL_DEFAULT_COLS, term?.rows ?? TERMINAL_DEFAULT_ROWS)
      .catch(() => setView({ status: 'failed', exitCode: null, message: terminalRpcMessages.failed }))
  }

  const copySelection = () => {
    const text = termRef.current?.getSelection() ?? ''
    if (text) void navigator.clipboard.writeText(text).catch(() => undefined)
    termRef.current?.focus()
  }
  const paste = () => {
    void navigator.clipboard
      .readText()
      .then(text => {
        if (text) termRef.current?.paste(text)
        termRef.current?.focus()
      })
      .catch(() => undefined)
  }
  const addSelectionToChat = () => {
    const term = termRef.current
    const range = term?.getSelectionPosition()
    const text = term
      ?.getSelection()
      .replace(/\r\n?/g, '\n')
      .replace(/^\n+|\n+$/g, '')
    if (!term || !range || !text || !onAddToChat) return
    onAddToChat({ terminalId, lineStart: range.start.y + 1, lineEnd: range.end.y + 1, text })
    term.clearSelection()
    term.focus()
  }

  const showFooter = view.status !== 'running' && view.status !== 'connecting'
  const footer = statusLabel(view)

  return (
    <div
      hidden={!visible}
      data-terminal-pane={terminalId}
      aria-label={label}
      role="group"
      className={cn('relative flex min-h-0 min-w-0 flex-col', className)}
      style={style}
      onPointerDownCapture={() => onFocusRequest(terminalId)}
      onFocusCapture={() => onFocusRequest(terminalId)}
    >
      <ContextMenu onOpenChange={open => open && setMenuHasSelection(termRef.current?.hasSelection() ?? false)}>
        <ContextMenuTrigger
          render={<div ref={hostRef} className="min-h-0 flex-1 overflow-hidden px-2 pt-1.5 pb-1" />}
        />
        <DropdownMenuContent className="w-48">
          {onAddToChat ? (
            <DropdownMenuItem disabled={!menuHasSelection} onClick={addSelectionToChat}>
              Add to chat
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem disabled={!menuHasSelection} onClick={copySelection}>
            Copy
          </DropdownMenuItem>
          <DropdownMenuItem disabled={view.status !== 'running'} onClick={paste}>
            Paste
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              termRef.current?.selectAll()
              termRef.current?.focus()
            }}
          >
            Select all
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              termRef.current?.clear()
              termRef.current?.focus()
            }}
          >
            Clear terminal
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => {
              termRef.current?.scrollToBottom()
              termRef.current?.focus()
            }}
          >
            Jump to latest
          </DropdownMenuItem>
        </DropdownMenuContent>
      </ContextMenu>
      {showFooter ? (
        <div
          role="status"
          className="border-border bg-card text-muted-foreground flex h-8 shrink-0 items-center justify-between gap-2 border-t px-3 text-[11.5px]"
        >
          <span className="truncate font-mono">{footer}</span>
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
