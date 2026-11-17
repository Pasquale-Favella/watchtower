import { Plus, Square, SquareSplitHorizontal, SquareSplitVertical, SquareTerminal, Trash2, X } from 'lucide-react'
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/renderer/components/ui/alert-dialog'
import { Button } from '@/renderer/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { isMac } from '@/renderer/features/workspace/platform-labels'
import { cn } from '@/renderer/shared/lib/utils'
import {
  TERMINAL_MAX_PER_GROUP,
  type TerminalId,
  type TerminalOwner,
  terminalOwnerKey,
  type TerminalTarget,
} from '@/shared/schemas/terminal.js'
import type { TaskId } from '@/shared/schemas/workspace.js'

import {
  isTerminalCloseShortcut,
  type TerminalAction,
  terminalActionShortcut,
  terminalShortcutLabel,
} from './terminal-keys'
import {
  clampTerminalDrawerHeight,
  terminalDrawerHeightBounds,
  type TerminalGroup,
  type TerminalPaneStatus,
} from './terminal-storage'
import { type TerminalExcerpt, TerminalPane } from './TerminalPane'
import { useTerminalTabs } from './use-terminal-tabs'

export type { TerminalExcerpt } from './TerminalPane'

const KEYBOARD_RESIZE_STEP = 16

export interface WorkspaceTerminalDrawerProps {
  readonly taskId?: TaskId | undefined
  readonly target?: TerminalTarget | undefined
  readonly groupId?: string | undefined
  readonly placement?: 'drawer' | 'panel' | undefined
  readonly onOpenLink?: ((url: string) => void) | undefined
  readonly onNewTerminal?: (() => void) | undefined
  readonly open: boolean
  /** Adds a selected excerpt to the chat draft. Omitted when the Task has no Conversation yet. */
  readonly onAddToChat?: ((excerpt: TerminalExcerpt & { readonly label: string }) => void) | undefined
}

/** Bottom drawer of the chat column. Closing it detaches the panes; the shells keep running. */
export function WorkspaceTerminalDrawer(props: WorkspaceTerminalDrawerProps) {
  const [mounted, setMounted] = useState(props.open)
  if (props.open && !mounted) setMounted(true)
  const owner = props.target ?? props.taskId
  if ((!mounted && !props.open) || !owner) return null
  return <TerminalDrawer key={terminalOwnerKey(owner)} {...props} owner={owner} />
}

export function WorkspaceTerminalPanel(
  props: Omit<WorkspaceTerminalDrawerProps, 'open' | 'placement'> & { readonly visible?: boolean | undefined },
) {
  return <WorkspaceTerminalDrawer {...props} open={props.visible ?? true} placement="panel" />
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

function terminalLabel(id: TerminalId): string {
  return `Terminal ${id.slice('term-'.length)}`
}

function groupDescription(group: TerminalGroup): { readonly icon: ReactNode; readonly label: string } {
  if (group.terminals.length < 2) return { icon: <Square className="size-3" />, label: 'Single' }
  return group.direction === 'vertical'
    ? { icon: <SquareSplitVertical className="size-3" />, label: 'Stacked' }
    : { icon: <SquareSplitHorizontal className="size-3" />, label: 'Side by side' }
}

/** Grid track and divider for each pane of the shown group, so panes never move between parents. */
function paneLayout(
  group: TerminalGroup | undefined,
  id: TerminalId,
  focused: boolean,
): { readonly visible: boolean; readonly style?: CSSProperties; readonly className?: string } {
  const index = group?.terminals.indexOf(id) ?? -1
  if (!group || index < 0) return { visible: false }
  const vertical = group.direction === 'vertical'
  const track = index + 1
  return {
    visible: true,
    style: vertical ? { gridRow: track, gridColumn: 1 } : { gridColumn: track, gridRow: 1 },
    className: cn(
      index > 0 && (vertical ? 'border-t' : 'border-l'),
      focused ? 'border-border' : 'border-border/70',
      focused && group.terminals.length > 1 && 'ring-primary/40 ring-1 ring-inset',
    ),
  }
}

function TerminalDrawer({
  owner,
  open,
  onAddToChat,
  onOpenLink,
  onNewTerminal,
  groupId,
  placement = 'drawer',
}: WorkspaceTerminalDrawerProps & { readonly owner: TerminalOwner }) {
  const tabs = useTerminalTabs(owner, groupId)
  const sectionRef = useRef<HTMLElement>(null)
  const containerHeight = useContainerHeight(sectionRef)
  const dragRef = useRef<{ readonly pointerY: number; readonly height: number; latest: number } | null>(null)
  const [pendingClose, setPendingClose] = useState<TerminalId | null>(null)
  const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
  const bounds = terminalDrawerHeightBounds(viewportHeight, containerHeight)
  const height = clampTerminalDrawerHeight(tabs.height, viewportHeight, containerHeight)
  const canCreate = tabs.canCreate
  const canSplit =
    canCreate &&
    (tabs.groups.find(group => tabs.active !== null && group.terminals.includes(tabs.active))?.terminals.length ?? 0) <
      TERMINAL_MAX_PER_GROUP
  const activeGroup = tabs.groups.find(group => tabs.active !== null && group.terminals.includes(tabs.active))
  const showSidebar = tabs.terminals.length > 1
  const showGroupHeaders = tabs.groups.length > 1 || tabs.groups.some(group => group.terminals.length > 1)

  /** A running shell asks first, because closing stops its process and clears its history. */
  const requestClose = (id: TerminalId) => {
    if (tabs.statuses[id] === 'running') setPendingClose(id)
    else tabs.close(id)
  }
  const run = (action: TerminalAction | 'close') => {
    if (action === 'close') {
      if (tabs.active) requestClose(tabs.active)
    } else if (onNewTerminal && (action === 'new' || tabs.terminals.length === 0)) onNewTerminal()
    else if (action === 'new') tabs.create()
    else tabs.split(action === 'split' ? 'horizontal' : 'vertical')
  }

  const onSectionKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (isTerminalCloseShortcut(event.nativeEvent, isMac)) {
      event.preventDefault()
      event.stopPropagation()
      if (!event.repeat) run('close')
      return
    }
    const action = terminalActionShortcut(event.nativeEvent, isMac)
    if (action === null || event.repeat) return
    event.preventDefault()
    run(action)
  }

  const onHandlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
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

  const actions = (
    <DrawerActions
      canCreate={canCreate}
      canSplit={canSplit}
      canClose={tabs.active !== null}
      onAction={run}
      variant={showSidebar ? 'sidebar' : 'floating'}
    />
  )
  const vertical = activeGroup?.direction === 'vertical'
  const trackCount = activeGroup?.terminals.length ?? 1
  const gridStyle: CSSProperties = vertical
    ? { gridTemplateRows: `repeat(${trackCount}, minmax(0, 1fr))`, gridTemplateColumns: 'minmax(0, 1fr)' }
    : { gridTemplateColumns: `repeat(${trackCount}, minmax(0, 1fr))`, gridTemplateRows: 'minmax(0, 1fr)' }

  return (
    <section
      ref={sectionRef}
      aria-label="Terminal"
      data-terminal-owner={placement}
      aria-hidden={!open}
      inert={!open}
      onKeyDown={onSectionKeyDown}
      className="border-border/80 bg-card relative flex shrink-0 flex-col border-t"
      style={{ height: placement === 'panel' ? '100%' : height, display: open ? undefined : 'none' }}
    >
      {placement === 'drawer' && (
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
          className="group focus-visible:ring-ring/50 absolute inset-x-0 -top-[3px] z-20 flex h-1.5 cursor-row-resize touch-none items-center justify-center outline-none focus-visible:ring-2"
        >
          <span className="bg-border group-hover:bg-primary/60 h-px w-10 rounded-full transition-colors" />
        </div>
      )}

      {tabs.error && (
        <p role="alert" className="text-destructive shrink-0 px-3 py-1 text-xs">
          {tabs.error}
        </p>
      )}
      {tabs.terminals.length === 0 ? (
        <div className="text-muted-foreground flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-4 py-6 text-center text-sm">
          <span>No terminals open.</span>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() => (onNewTerminal ? onNewTerminal() : tabs.create())}
          >
            <Plus />
            New terminal <span className="text-muted-foreground">({terminalShortcutLabel('new', isMac)})</span>
          </Button>
        </div>
      ) : (
        <div className={cn('flex min-h-0 flex-1', showSidebar && 'gap-1.5')}>
          <div className="relative min-h-0 min-w-0 flex-1">
            <div className="grid h-full w-full min-w-0 overflow-hidden" style={gridStyle}>
              {tabs.terminals.map(id => {
                const focused = tabs.active === id
                const layout = paneLayout(activeGroup, id, focused)
                return (
                  <TerminalPane
                    key={id}
                    target={owner}
                    onOpenLink={onOpenLink}
                    terminalId={id}
                    label={terminalLabel(id)}
                    visible={layout.visible}
                    focused={focused}
                    className={layout.className}
                    style={layout.style}
                    onFocusRequest={tabs.select}
                    onStatusChange={tabs.reportStatus}
                    onAddToChat={
                      onAddToChat ? excerpt => onAddToChat({ ...excerpt, label: terminalLabel(id) }) : undefined
                    }
                  />
                )
              })}
            </div>
            {showSidebar ? null : <div className="pointer-events-none absolute top-2 right-2 z-20">{actions}</div>}
          </div>
          {showSidebar ? (
            <aside aria-label="Terminals" className="border-border/70 bg-muted/10 flex w-36 min-w-36 flex-col border-l">
              {actions}
              <div
                role="tablist"
                aria-orientation="vertical"
                aria-label="Terminal sessions"
                onKeyDown={event => {
                  if (!(event.target instanceof HTMLElement) || event.target.getAttribute('role') !== 'tab') return
                  const index = tabs.active ? tabs.terminals.indexOf(tabs.active) : 0
                  let next = index
                  if (event.key === 'ArrowDown' || event.key === 'ArrowRight')
                    next = (index + 1) % tabs.terminals.length
                  else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft')
                    next = (index - 1 + tabs.terminals.length) % tabs.terminals.length
                  else if (event.key === 'Home') next = 0
                  else if (event.key === 'End') next = tabs.terminals.length - 1
                  else return
                  event.preventDefault()
                  const id = tabs.terminals[next]
                  if (id) tabs.select(id)
                }}
                className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1 py-1"
              >
                {tabs.groups.map(group => (
                  <TerminalSidebarGroup
                    key={group.terminals[0]}
                    group={group}
                    showHeader={showGroupHeaders}
                    active={tabs.active}
                    statuses={tabs.statuses}
                    onSelect={tabs.select}
                    onClose={requestClose}
                  />
                ))}
              </div>
            </aside>
          ) : null}
        </div>
      )}

      <AlertDialog open={pendingClose !== null} onOpenChange={open => !open && setPendingClose(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Close {pendingClose ? terminalLabel(pendingClose) : 'terminal'}?</AlertDialogTitle>
            <AlertDialogDescription>This stops the running process and clears its history.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (pendingClose) tabs.close(pendingClose)
                setPendingClose(null)
              }}
            >
              Close terminal
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function DrawerActions({
  canCreate,
  canSplit,
  canClose,
  onAction,
  variant,
}: {
  readonly canCreate: boolean
  readonly canSplit: boolean
  readonly canClose: boolean
  readonly onAction: (action: TerminalAction | 'close') => void
  readonly variant: 'floating' | 'sidebar'
}) {
  const limit = `Up to ${TERMINAL_MAX_PER_GROUP} terminals per split group`
  const items = [
    {
      action: 'split' as const,
      icon: <SquareSplitHorizontal />,
      label: canSplit ? `Split terminal horizontally (${terminalShortcutLabel('split', isMac)})` : limit,
      disabled: !canSplit,
    },
    {
      action: 'splitVertical' as const,
      icon: <SquareSplitVertical />,
      label: canSplit ? `Split terminal vertically (${terminalShortcutLabel('splitVertical', isMac)})` : limit,
      disabled: !canSplit,
    },
    {
      action: 'new' as const,
      icon: <Plus />,
      label: canCreate ? `New terminal (${terminalShortcutLabel('new', isMac)})` : limit,
      disabled: !canCreate,
    },
    { action: 'close' as const, icon: <Trash2 />, label: 'Close terminal', disabled: !canClose },
  ]
  return (
    <div
      role="toolbar"
      aria-label="Terminal actions"
      className={cn(
        'pointer-events-auto flex items-stretch',
        variant === 'floating'
          ? 'border-border/80 bg-background inline-flex overflow-hidden rounded-md border shadow-xs'
          : 'border-border/70 h-[22px] justify-end border-b',
      )}
    >
      {items.map((item, index) => (
        <Tooltip key={item.action}>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={item.label}
                aria-disabled={item.disabled}
                onClick={() => !item.disabled && onAction(item.action)}
                className={cn(
                  'text-foreground/90 focus-visible:ring-ring/50 inline-flex items-center outline-none focus-visible:ring-2 focus-visible:ring-inset [&_svg]:size-3.25',
                  variant === 'floating' ? 'hover:bg-accent p-1' : 'hover:bg-accent/70 h-full px-1',
                  index > 0 && (variant === 'floating' ? 'border-border/80 border-l' : 'border-border/70 border-l'),
                  item.disabled && 'cursor-not-allowed opacity-60 hover:bg-transparent',
                )}
              >
                {item.icon}
              </button>
            }
          />
          <TooltipContent side="bottom">{item.label}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  )
}

function TerminalSidebarGroup({
  group,
  showHeader,
  active,
  statuses,
  onSelect,
  onClose,
}: {
  readonly group: TerminalGroup
  readonly showHeader: boolean
  readonly active: TerminalId | null
  readonly statuses: Partial<Record<TerminalId, TerminalPaneStatus>>
  readonly onSelect: (id: TerminalId) => void
  readonly onClose: (id: TerminalId) => void
}) {
  const groupActive = active !== null && group.terminals.includes(active)
  const description = groupDescription(group)
  const first = group.terminals[0]
  return (
    <div role="presentation" className="space-y-0.5">
      {showHeader && first ? (
        <button
          type="button"
          tabIndex={-1}
          onClick={() => onSelect(groupActive && active ? active : first)}
          className={cn(
            'flex h-[22px] w-full items-center gap-1 rounded px-1.5 text-[10.5px]',
            groupActive ? 'bg-accent/50 text-foreground' : 'text-muted-foreground hover:bg-accent/40',
          )}
        >
          {description.icon}
          <span className="min-w-0 flex-1 truncate text-left">{description.label}</span>
          <span className="text-muted-foreground/70 text-[10px] tabular-nums">{group.terminals.length}</span>
        </button>
      ) : null}
      {group.terminals.map(id => {
        const selected = active === id
        const label = terminalLabel(id)
        return (
          <div
            key={id}
            className={cn(
              'group/tab flex h-6 w-full items-center gap-0.5 rounded-md pr-2 pl-1 text-xs',
              selected ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60',
            )}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Close ${label}`}
                    onClick={() => onClose(id)}
                    className="hover:bg-muted focus-visible:ring-ring/50 relative flex size-4 shrink-0 items-center justify-center rounded-sm outline-none focus-visible:ring-2"
                  >
                    <SquareTerminal className="size-3 group-focus-within/tab:hidden group-hover/tab:hidden" />
                    <X className="hidden size-3 group-focus-within/tab:block group-hover/tab:block" />
                  </button>
                }
              />
              <TooltipContent side="left">Close {label}</TooltipContent>
            </Tooltip>
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(id)}
              className="focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2"
            >
              <span className="truncate font-mono text-[11px]">{label}</span>
              <span
                aria-hidden
                className={cn('ml-auto size-1.5 shrink-0 rounded-full', statusDotClass(statuses[id]))}
              />
            </button>
          </div>
        )
      })}
    </div>
  )
}
