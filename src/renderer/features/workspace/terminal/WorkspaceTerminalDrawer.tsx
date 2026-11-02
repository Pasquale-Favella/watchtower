import { ChevronDown, Plus, X } from 'lucide-react'
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react'

import { Button } from '@/renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { isMac } from '@/renderer/features/workspace/platform-labels'
import { cn } from '@/renderer/shared/lib/utils'
import { TERMINAL_MAX_PER_TASK } from '@/shared/schemas/terminal.js'
import type { TaskId } from '@/shared/schemas/workspace.js'

import { clampTerminalDrawerHeight, terminalDrawerHeightBounds, type TerminalPaneStatus } from './terminal-storage'
import { TerminalPane } from './TerminalPane'
import { useTerminalTabs } from './use-terminal-tabs'

const KEYBOARD_RESIZE_STEP = 16

export interface WorkspaceTerminalDrawerProps {
  readonly taskId: TaskId
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

/** Bottom drawer of the chat column. Closing it detaches the panes; the shells keep running. */
export function WorkspaceTerminalDrawer({ taskId, open, onOpenChange }: WorkspaceTerminalDrawerProps) {
  if (!open) return null
  return <TerminalDrawer key={taskId} taskId={taskId} onOpenChange={onOpenChange} />
}

function useContainerHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const container = ref.current?.parentElement
    if (!container) return
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) setHeight(entry.contentRect.height)
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [ref])
  return height
}

function statusDotClass(status: TerminalPaneStatus | undefined): string {
  switch (status) {
    case 'running':
      return 'bg-emerald-500'
    case 'exited':
      return 'bg-muted-foreground/50'
    case 'failed':
      return 'bg-destructive'
    default:
      return 'bg-muted-foreground/30'
  }
}

function TerminalDrawer({ taskId, onOpenChange }: Omit<WorkspaceTerminalDrawerProps, 'open'>) {
  const tabs = useTerminalTabs(taskId)
  const sectionRef = useRef<HTMLElement>(null)
  const containerHeight = useContainerHeight(sectionRef)
  const dragRef = useRef<{ readonly pointerY: number; readonly height: number; latest: number } | null>(null)
  const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
  const bounds = terminalDrawerHeightBounds(viewportHeight, containerHeight)
  const height = clampTerminalDrawerHeight(tabs.height, viewportHeight, containerHeight)
  const canCreate = tabs.terminals.length < TERMINAL_MAX_PER_TASK

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = { pointerY: event.clientY, height, latest: height }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onHandlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    drag.latest = clampTerminalDrawerHeight(
      drag.height + drag.pointerY - event.clientY,
      viewportHeight,
      containerHeight,
    )
    tabs.previewHeight(drag.latest)
  }
  const onHandlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
    tabs.commitHeight(drag.latest)
  }
  const onHandleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const delta = event.key === 'ArrowUp' ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP
    tabs.commitHeight(clampTerminalDrawerHeight(height + delta, viewportHeight, containerHeight))
  }

  return (
    <section
      ref={sectionRef}
      aria-label="Terminal"
      className="border-border bg-card relative flex shrink-0 flex-col border-t"
      style={{ height }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize terminal"
        aria-valuemin={bounds.min}
        aria-valuemax={bounds.max}
        aria-valuenow={height}
        tabIndex={0}
        onPointerDown={onHandlePointerDown}
        onPointerMove={onHandlePointerMove}
        onPointerUp={onHandlePointerUp}
        onPointerCancel={onHandlePointerUp}
        onKeyDown={onHandleKeyDown}
        className="group focus-visible:ring-ring/50 absolute inset-x-0 -top-[3px] z-10 flex h-[6px] cursor-row-resize touch-none items-center justify-center outline-none focus-visible:ring-2"
      >
        <span className="bg-border group-hover:bg-primary/60 h-px w-10 rounded-full transition-colors" />
      </div>

      <div className="border-border flex h-9 shrink-0 items-center gap-1 border-b px-2">
        <div role="tablist" aria-label="Terminals" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.terminals.map(id => {
            const selected = tabs.active === id
            const number = id.slice('term-'.length)
            return (
              <div
                key={id}
                className={cn(
                  'border-border flex h-7 shrink-0 items-center rounded-md border text-[11.5px]',
                  selected ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60',
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => tabs.select(id)}
                  className="focus-visible:ring-ring/50 flex h-full items-center gap-1.5 pr-1 pl-2 outline-none focus-visible:ring-2"
                >
                  <span aria-hidden className={cn('size-1.5 rounded-full', statusDotClass(tabs.statuses[id]))} />
                  <span className="font-mono">Terminal {number}</span>
                </button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Close terminal ${number}`}
                  onClick={() => tabs.close(id)}
                  className="mr-0.5 size-5"
                >
                  <X />
                </Button>
              </div>
            )
          })}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="icon-xs"
                  aria-label="New terminal"
                  disabled={!canCreate}
                  onClick={() => tabs.create()}
                  className="border-border h-7 w-7 shrink-0"
                >
                  <Plus />
                </Button>
              }
            />
            <TooltipContent side="top">
              {canCreate ? 'New terminal' : `Up to ${TERMINAL_MAX_PER_TASK} terminals per Task`}
            </TooltipContent>
          </Tooltip>
        </div>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Hide terminal drawer"
                onClick={() => onOpenChange(false)}
                className="size-7 shrink-0"
              >
                <ChevronDown />
              </Button>
            }
          />
          <TooltipContent side="top">{isMac ? 'Hide terminal (⌘J)' : 'Hide terminal (Ctrl+J)'}</TooltipContent>
        </Tooltip>
      </div>

      <div className="relative min-h-0 flex-1">
        {tabs.terminals.length === 0 ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-[11.5px]">
            <span>No terminals open for this Task.</span>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="h-7 text-[11.5px]"
              onClick={() => tabs.create()}
            >
              <Plus />
              New terminal
            </Button>
          </div>
        ) : null}
        {tabs.terminals.map(id => (
          <TerminalPane
            key={id}
            taskId={taskId}
            terminalId={id}
            active={tabs.active === id}
            onStatusChange={tabs.reportStatus}
          />
        ))}
      </div>
    </section>
  )
}
