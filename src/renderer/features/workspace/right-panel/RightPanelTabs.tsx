import {
  ChevronLeft,
  ChevronRight,
  File,
  FileDiff,
  Files,
  GitPullRequest,
  Globe,
  MessagesSquare,
  Plus,
  Smartphone,
  SquareTerminal,
  X,
} from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { ContextMenu, ContextMenuTrigger } from '@/renderer/components/ui/context-menu'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu'
import { cn } from '@/renderer/shared/lib/utils'

import { type RightPanelSurface, surfaceKind, surfaceLabel, surfaceResource } from './right-panel-state.js'
import type { RightPanelControls } from './use-right-panel.js'

export function SurfaceIcon({ surface }: { readonly surface: RightPanelSurface }): React.JSX.Element {
  const icons = {
    diff: FileDiff,
    files: Files,
    file: File,
    browser: Globe,
    terminal: SquareTerminal,
    device: Smartphone,
    'pull-requests': GitPullRequest,
    'pull-request': GitPullRequest,
    'side-chat': MessagesSquare,
  }
  const Icon = icons[surfaceKind(surface)]
  return <Icon aria-hidden="true" className="size-3.5 shrink-0" />
}

export interface PanelLauncherProps {
  readonly canInspect: boolean
  readonly onOpenSurface: (surface: RightPanelSurface) => void
  readonly onAddBrowser?: (() => void) | undefined
  readonly onAddTerminal?: (() => void) | undefined
  readonly onAddDevice?: (() => void) | undefined
  readonly onAddPullRequests?: (() => void) | undefined
  readonly onAddSideChat?: (() => void) | undefined
  readonly sideChatHistory?: readonly { readonly id: string; readonly title: string }[] | undefined
  readonly onOpenSideChat?: ((id: string) => void) | undefined
}

export function PanelLauncher(props: PanelLauncherProps): React.JSX.Element {
  const items = launcherItems(props)
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 p-6">
      <p className="text-muted-foreground text-sm">Open a panel</p>
      <div className="grid w-full max-w-64 grid-cols-2 gap-2">
        {items.map(item => (
          <Button
            key={item.label}
            variant="outline"
            className="h-16 flex-col gap-2 text-xs"
            disabled={!item.action}
            onClick={item.action}
            title={item.hint}
          >
            {item.icon}
            {item.label}
          </Button>
        ))}
      </div>
    </div>
  )
}

function launcherItems(props: PanelLauncherProps): {
  readonly label: string
  readonly icon: ReactNode
  readonly action: (() => void) | undefined
  readonly hint: string
}[] {
  return [
    { label: 'Browser', icon: <Globe />, action: props.onAddBrowser, hint: 'Open a browser tab' },
    { label: 'Terminal', icon: <SquareTerminal />, action: props.onAddTerminal, hint: 'Open a terminal tab' },
    {
      label: 'Device',
      icon: <Smartphone />,
      action: props.onAddDevice,
      hint: 'Connect an Android device or iOS simulator',
    },
    {
      label: 'Pull requests',
      icon: <GitPullRequest />,
      action: props.onAddPullRequests,
      hint: props.canInspect ? 'Browse repository pull requests' : 'Choose a project to browse pull requests',
    },
    {
      label: 'Side chat',
      icon: <MessagesSquare />,
      action: props.onAddSideChat,
      hint: props.onAddSideChat ? 'Ask about this conversation in a side chat' : 'Available after the first message',
    },
    {
      label: 'Diff',
      icon: <FileDiff />,
      action: props.canInspect ? () => props.onOpenSurface('diff') : undefined,
      hint: props.canInspect ? 'Review changes' : 'Choose a project to review changes',
    },
    {
      label: 'Files',
      icon: <Files />,
      action: props.canInspect ? () => props.onOpenSurface('files') : undefined,
      hint: props.canInspect ? 'Browse files' : 'Choose a project to browse files',
    },
  ]
}

interface Props extends PanelLauncherProps {
  readonly controls: RightPanelControls
  readonly idPrefix: string
  readonly onCloseSurface: (surface: RightPanelSurface) => void
  readonly onCloseOthers: (surface: RightPanelSurface) => void
  readonly onCloseToRight: (surface: RightPanelSurface) => void
  readonly onCloseAll: () => void
  readonly titleForSurface?: ((surface: RightPanelSurface) => string) | undefined
}

export function RightPanelTabs(props: Props): React.JSX.Element {
  const { controls } = props
  const viewport = useRef<HTMLDivElement>(null)
  const buttons = useRef(new Map<RightPanelSurface, HTMLButtonElement>())
  const dragged = useRef<RightPanelSurface | null>(null)
  const [overflow, setOverflow] = useState({ left: false, right: false })
  const [menuOpen, setMenuOpen] = useState(false)
  const [dismissedRequest, setDismissedRequest] = useState(controls.addMenuRequest)
  const launcherOpen = menuOpen || controls.addMenuRequest !== dismissedRequest

  const measure = () => {
    const element = viewport.current
    if (!element) return
    const next = {
      left: element.scrollLeft > 1,
      right: element.scrollLeft + element.clientWidth < element.scrollWidth - 1,
    }
    setOverflow(previous => (previous.left === next.left && previous.right === next.right ? previous : next))
  }
  useEffect(() => {
    const element = viewport.current
    if (!element) return
    const frame = requestAnimationFrame(measure)
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const child of element.children) observer.observe(child)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [controls.surfaces.length])
  useEffect(() => {
    if (controls.active) buttons.current.get(controls.active)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [controls.active])

  const keyDown = (event: KeyboardEvent<HTMLButtonElement>, surface: RightPanelSurface) => {
    const index = controls.surfaces.indexOf(surface)
    if (event.altKey && event.shiftKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      controls.move(surface, event.key === 'ArrowLeft' ? -1 : 1)
      return
    }
    let next = index
    if (event.key === 'ArrowLeft') next = (index - 1 + controls.surfaces.length) % controls.surfaces.length
    else if (event.key === 'ArrowRight') next = (index + 1) % controls.surfaces.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = controls.surfaces.length - 1
    else if (event.key === 'Delete') {
      event.preventDefault()
      props.onCloseSurface(surface)
      return
    } else return
    event.preventDefault()
    const target = controls.surfaces[next]
    if (!target) return
    controls.activate(target)
    buttons.current.get(target)?.focus()
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-0.5">
      {overflow.left && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Scroll tabs left"
          onClick={() => viewport.current?.scrollBy({ left: -180, behavior: 'smooth' })}
        >
          <ChevronLeft />
        </Button>
      )}
      <div
        ref={viewport}
        role="tablist"
        aria-label="Panel tabs"
        onScroll={measure}
        className="flex min-w-0 flex-1 [scrollbar-width:none] gap-0.5 overflow-x-auto"
        onWheel={event => {
          if (event.deltaY && viewport.current && viewport.current.scrollWidth > viewport.current.clientWidth)
            viewport.current.scrollLeft += event.deltaY
        }}
      >
        {controls.surfaces.map((surface, index) => {
          const title = props.titleForSurface?.(surface) ?? surfaceLabel(surface)
          const selected = controls.active === surface
          return (
            <ContextMenu key={surface}>
              <ContextMenuTrigger
                render={
                  <div
                    className={cn(
                      'group/tab border-border/70 flex h-8 max-w-48 min-w-20 shrink-0 items-center rounded-md border border-transparent',
                      selected
                        ? 'bg-muted text-foreground border-border/70'
                        : 'text-muted-foreground hover:bg-muted/60',
                    )}
                  />
                }
                draggable
                onDragStart={event => {
                  dragged.current = surface
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', surface)
                }}
                onDragEnd={() => {
                  dragged.current = null
                }}
                onDragOver={event => {
                  if (dragged.current) {
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                  }
                }}
                onDrop={event => {
                  event.preventDefault()
                  if (dragged.current) controls.moveTo(dragged.current, index)
                  dragged.current = null
                }}
              >
                <button
                  type="button"
                  role="tab"
                  id={`${props.idPrefix}-tab-${encodeURIComponent(surface)}`}
                  aria-controls={`${props.idPrefix}-panel-${encodeURIComponent(surface)}`}
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  ref={element => {
                    if (element) buttons.current.set(surface, element)
                    else buttons.current.delete(surface)
                  }}
                  onClick={() => controls.activate(surface)}
                  onKeyDown={event => keyDown(event, surface)}
                  title={title}
                  onMouseDown={event => {
                    if (event.button === 1) event.preventDefault()
                  }}
                  onAuxClick={event => {
                    if (event.button === 1) {
                      event.preventDefault()
                      props.onCloseSurface(surface)
                    }
                  }}
                  className="focus-visible:ring-ring flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-sm px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset"
                >
                  <SurfaceIcon surface={surface} />
                  <span className="truncate">{title}</span>
                </button>
                <button
                  type="button"
                  aria-label={`Close ${title}`}
                  tabIndex={-1}
                  onClick={() => props.onCloseSurface(surface)}
                  className="hover:bg-background focus-visible:ring-ring mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded opacity-0 outline-none group-focus-within/tab:opacity-100 group-hover/tab:opacity-100 focus-visible:ring-2"
                >
                  <X className="size-3" />
                </button>
              </ContextMenuTrigger>
              <DropdownMenuContent className="w-44">
                {surfaceKind(surface) === 'file' && (
                  <>
                    <DropdownMenuItem
                      onClick={() => {
                        void navigator.clipboard.writeText(surfaceResource(surface)).catch(() => undefined)
                      }}
                    >
                      Copy file path
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onClick={() => props.onCloseSurface(surface)}>Close</DropdownMenuItem>
                <DropdownMenuItem disabled={controls.surfaces.length < 2} onClick={() => props.onCloseOthers(surface)}>
                  Close others
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={index === controls.surfaces.length - 1}
                  onClick={() => props.onCloseToRight(surface)}
                >
                  Close to the right
                </DropdownMenuItem>
                <DropdownMenuItem onClick={props.onCloseAll}>Close all</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={index === 0} onClick={() => controls.move(surface, -1)}>
                  Move left
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={index === controls.surfaces.length - 1}
                  onClick={() => controls.move(surface, 1)}
                >
                  Move right
                </DropdownMenuItem>
              </DropdownMenuContent>
            </ContextMenu>
          )
        })}
      </div>
      {overflow.right && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Scroll tabs right"
          onClick={() => viewport.current?.scrollBy({ left: 180, behavior: 'smooth' })}
        >
          <ChevronRight />
        </Button>
      )}
      <DropdownMenu
        open={launcherOpen}
        onOpenChange={open => {
          setMenuOpen(open)
          if (!open) setDismissedRequest(controls.addMenuRequest)
        }}
      >
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="Add panel tab" />}>
          <Plus />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          {launcherItems(props).map(item => (
            <DropdownMenuItem key={item.label} disabled={!item.action} onClick={item.action} title={item.hint}>
              {item.icon}
              {item.label}
            </DropdownMenuItem>
          ))}
          {Boolean(props.sideChatHistory?.length) && <DropdownMenuSeparator />}
          {props.sideChatHistory?.slice(0, 10).map(chat => (
            <DropdownMenuItem key={chat.id} onClick={() => props.onOpenSideChat?.(chat.id)}>
              <MessagesSquare />
              {chat.title}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
