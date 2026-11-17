import { Maximize2, Minimize2, RefreshCw, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/renderer/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import { cn } from '@/renderer/shared/lib/utils'
import type { ProjectId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'

import { isMac } from '../platform-labels.js'
import { ReviewCommentsProvider } from '../review/ReviewCommentsProvider.js'
import { isTerminalFocusTarget } from '../terminal/terminal-keys.js'
import type { WorkspaceImageContext } from '../WorkspaceImageAnnotation.js'
import { closePanelSurfaces } from './close-panel-surfaces.js'
import { DiffTab } from './DiffTab.js'
import { FilePanel, FilesTab } from './FilesTab.js'
import { InspectionNotice } from './inspection-ui.js'
import {
  browserStorage,
  checkoutScope,
  clampRightPanelWidth,
  readRightPanelWidth,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_WIDE_BREAKPOINT,
  type RightPanelSurface,
  surfaceKind,
  surfaceResource,
  writeRightPanelWidth,
} from './right-panel-state.js'
import { PanelLauncher, RightPanelTabs } from './RightPanelTabs.js'
import { useFlushFileEdits } from './use-file-edit-session.js'
import { type RightPanelControls, useRightPanel } from './use-right-panel.js'

const REFRESH_DEBOUNCE_MS = 250
const KEYBOARD_RESIZE_STEP = 16

export interface WorkspaceRightPanelProps {
  readonly projectId?: ProjectId | undefined
  readonly checkoutId?: WorkspaceCheckoutId | undefined
  readonly controls?: RightPanelControls | undefined
  readonly open?: boolean | undefined
  readonly onOpenChange?: ((open: boolean) => void) | undefined
  readonly tab?: RightPanelSurface | undefined
  readonly onTabChange?: ((tab: RightPanelSurface) => void) | undefined
  readonly reviewOwnerKey?: string | undefined
  readonly refreshKey: number
  readonly onReferencePath: (path: string) => void
  readonly onAddImage?: ((image: WorkspaceImageContext) => Promise<void>) | undefined
  readonly renderSurface?: ((surface: RightPanelSurface, visible: boolean) => React.ReactNode) | undefined
  readonly titleForSurface?: ((surface: RightPanelSurface) => string) | undefined
  readonly onAddBrowser?: (() => void) | undefined
  readonly onAddTerminal?: (() => void) | undefined
  readonly onAddDevice?: (() => void) | undefined
  readonly onAddPullRequests?: (() => void) | undefined
  readonly onAddSideChat?: (() => void) | undefined
  readonly sideChatHistory?: readonly { readonly id: string; readonly title: string }[] | undefined
  readonly onOpenSideChat?: ((id: string) => void) | undefined
  readonly notice?: string | null | undefined
  /** Resource owners may confirm and release a tab before it is removed. Hiding the panel never calls it. */
  readonly beforeCloseSurface?: ((surface: RightPanelSurface) => boolean | Promise<boolean>) | undefined
  /** Releases the resource after every requested close has been confirmed. */
  readonly onCloseSurface?: ((surface: RightPanelSurface) => void | Promise<void>) | undefined
}

export function WorkspaceRightPanel(props: WorkspaceRightPanelProps): React.JSX.Element {
  return (
    <ReviewCommentsProvider ownerKey={props.reviewOwnerKey ?? `project:${props.projectId ?? 'none'}`}>
      <WorkspaceRightPanelContent {...props} />
    </ReviewCommentsProvider>
  )
}

function WorkspaceRightPanelContent(props: WorkspaceRightPanelProps): React.JSX.Element {
  const flushFileEdits = useFlushFileEdits()
  const { controls: providedControls, tab, onTabChange, open, onOpenChange } = props
  const local = useRightPanel(providedControls ? null : `project:${props.projectId ?? 'none'}`)
  const controls = useMemo(
    () =>
      providedControls ?? {
        ...local,
        open: open ?? local.open,
        active: tab ?? local.active,
        surfaces: tab && !local.surfaces.includes(tab) ? [...local.surfaces, tab] : local.surfaces,
        setOpen: onOpenChange ?? local.setOpen,
        activate: (surface: RightPanelSurface) => {
          local.activate(surface)
          onTabChange?.(surface)
        },
      },
    [local, providedControls, onOpenChange, onTabChange, open, tab],
  )
  const wide = useWideViewport()
  const { revision, refresh } = useInspectionRevision(controls.open, props.refreshKey)
  const scope = props.projectId ? checkoutScope(props.projectId, props.checkoutId) : null
  const idPrefix = useId()
  const [mountedSurfaces, setMountedSurfaces] = useState<ReadonlySet<RightPanelSurface>>(() => new Set())
  const activeSurface = controls.active
  const [reveal, setReveal] = useState<{ readonly path: string; readonly line: number } | null>(null)
  useEffect(() => {
    function revealComment(event: Event): void {
      const detail = (event as CustomEvent<{ ownerKey: string; path: string; line: number; mode: string }>).detail
      if (detail.ownerKey !== props.reviewOwnerKey) return
      if (detail.mode === 'diff') controls.openSurface('diff')
      else {
        setReveal({ path: detail.path, line: detail.line })
        controls.openFile(detail.path)
      }
    }
    window.addEventListener('watchtower:reveal-review-comment', revealComment)
    return () => window.removeEventListener('watchtower:reveal-review-comment', revealComment)
  }, [controls, props.reviewOwnerKey])
  if (controls.open && activeSurface && !mountedSurfaces.has(activeSurface)) {
    setMountedSurfaces(previous => new Set([...previous, activeSurface]))
  }
  const [closeError, setCloseError] = useState<string | null>(null)
  const closing = useRef(false)
  const closeProjectId = props.projectId
  const closeCheckoutId = props.checkoutId
  const confirmSurfaceClose = props.beforeCloseSurface
  const beforeCloseSurface = useCallback(
    async (surface: RightPanelSurface): Promise<boolean> => {
      if (surfaceKind(surface) === 'file' && closeProjectId) {
        if (!(await flushFileEdits(checkoutScope(closeProjectId, closeCheckoutId), surfaceResource(surface))))
          return false
      }
      return (await confirmSurfaceClose?.(surface)) ?? true
    },
    [closeProjectId, closeCheckoutId, confirmSurfaceClose, flushFileEdits],
  )
  const onCloseSurface = props.onCloseSurface

  const closeSurfaces = useCallback(
    async (surfaces: readonly RightPanelSurface[], activate?: RightPanelSurface) => {
      if (closing.current) return
      closing.current = true
      setCloseError(null)
      try {
        const closed = await closePanelSurfaces(surfaces, {
          confirm: beforeCloseSurface,
          release: onCloseSurface,
          remove: controls.closeSurface,
        })
        if (closed && activate) controls.activate(activate)
      } catch {
        setCloseError('Could not close the panel tab. Try again.')
      } finally {
        closing.current = false
      }
    },
    [beforeCloseSurface, controls, onCloseSurface],
  )

  useEffect(() => {
    if (!controls.open) return
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (
        event.defaultPrevented ||
        event.repeat ||
        !mod ||
        event.altKey ||
        event.shiftKey ||
        event.code !== 'KeyW' ||
        isTerminalFocusTarget(event.target)
      )
        return
      if (
        document.querySelector(
          '[data-slot="dropdown-menu-content"]:not([data-closed]),[data-slot="alert-dialog-content"],[data-slot="dialog-content"]',
        )
      )
        return
      event.preventDefault()
      if (controls.active) void closeSurfaces([controls.active])
      else controls.setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeSurfaces, controls])

  const launcher = {
    canInspect: scope !== null,
    onOpenSurface: controls.openSurface,
    onAddBrowser: props.onAddBrowser,
    onAddTerminal: props.onAddTerminal,
    onAddDevice: props.onAddDevice,
    onAddPullRequests: props.onAddPullRequests,
    onAddSideChat: props.onAddSideChat,
    sideChatHistory: props.sideChatHistory,
    onOpenSideChat: props.onOpenSideChat,
  }
  const content = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-slot="workspace-panel-content">
      <header className="border-border flex h-11 shrink-0 items-center gap-1 border-b px-1.5">
        <RightPanelTabs
          {...launcher}
          controls={controls}
          idPrefix={idPrefix}
          titleForSurface={props.titleForSurface}
          onCloseSurface={surface => {
            void closeSurfaces([surface])
          }}
          onCloseOthers={surface => {
            void closeSurfaces(
              controls.surfaces.filter(item => item !== surface),
              surface,
            )
          }}
          onCloseToRight={surface => {
            void closeSurfaces(controls.surfaces.slice(controls.surfaces.indexOf(surface) + 1))
          }}
          onCloseAll={() => {
            void closeSurfaces(controls.surfaces)
          }}
        />
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {scope && activeSurface && !['browser', 'terminal'].includes(surfaceKind(activeSurface)) && (
            <PanelButton label="Refresh changes" onClick={refresh}>
              <RefreshCw />
            </PanelButton>
          )}
          {wide && (
            <PanelButton
              label={controls.maximized ? 'Restore panel size' : 'Maximize panel'}
              onClick={controls.toggleMaximized}
            >
              {controls.maximized ? <Minimize2 /> : <Maximize2 />}
            </PanelButton>
          )}
          <PanelButton label="Close right panel" onClick={() => controls.setOpen(false)}>
            <X />
          </PanelButton>
        </div>
      </header>
      {closeError && (
        <p role="alert" className="text-destructive px-3 py-2 text-xs">
          {closeError}
        </p>
      )}
      {props.notice && (
        <p role="alert" className="text-destructive px-3 py-2 text-xs">
          {props.notice}
        </p>
      )}
      {controls.surfaces.length === 0 && <PanelLauncher {...launcher} />}
      {controls.surfaces
        .filter(surface => mountedSurfaces.has(surface))
        .map(surface => {
          const visible = controls.open && controls.active === surface
          const kind = surfaceKind(surface)
          let body: React.ReactNode
          if (
            kind === 'browser' ||
            kind === 'terminal' ||
            kind === 'device' ||
            kind === 'pull-requests' ||
            kind === 'pull-request' ||
            kind === 'side-chat'
          )
            body = props.renderSurface?.(surface, visible)
          else if (!scope) body = <InspectionNotice>Choose a project to inspect its checkout.</InspectionNotice>
          else if (kind === 'diff')
            body = (
              <DiffTab
                scope={scope}
                revision={revision}
                onOpenFile={path => controls.openFile(path)}
                onReferencePath={props.onReferencePath}
              />
            )
          else if (kind === 'files')
            body = (
              <FilesTab
                scope={scope}
                revision={revision}
                onReferencePath={props.onReferencePath}
                onAddImage={props.onAddImage}
                onOpenFile={path => controls.openFile(path)}
              />
            )
          else
            body = (
              <FilePanel
                scope={scope}
                revision={revision}
                path={surfaceResource(surface)}
                revealLine={reveal?.path === surfaceResource(surface) ? reveal.line : null}
                onAddImage={props.onAddImage}
                onOpenFile={path => controls.openFile(path)}
                onReferencePath={props.onReferencePath}
              />
            )
          return (
            <div
              key={surface}
              role="tabpanel"
              id={`${idPrefix}-panel-${encodeURIComponent(surface)}`}
              aria-labelledby={`${idPrefix}-tab-${encodeURIComponent(surface)}`}
              aria-hidden={!visible}
              inert={!visible}
              style={{ display: visible ? 'flex' : 'none' }}
              className="min-h-0 min-w-0 flex-1 flex-col"
            >
              {body}
            </div>
          )
        })}
    </div>
  )
  if (!wide)
    return (
      <Sheet open={controls.open} onOpenChange={controls.setOpen}>
        <SheetContent side="right" showCloseButton={false} className="w-[min(760px,95vw)] gap-0 p-0 sm:max-w-none">
          <SheetTitle className="sr-only">Right panel</SheetTitle>
          {content}
        </SheetContent>
      </Sheet>
    )
  return (
    <InlinePanel open={controls.open} maximized={controls.maximized}>
      {content}
    </InlinePanel>
  )
}

function PanelButton({
  label,
  onClick,
  children,
}: {
  readonly label: string
  readonly onClick: () => void
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={label} onClick={onClick} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

function InlinePanel({
  children,
  open,
  maximized,
}: {
  readonly children: React.ReactNode
  readonly open: boolean
  readonly maximized: boolean
}): React.JSX.Element {
  const panelRef = useRef<HTMLElement | null>(null)
  const [width, setWidth] = useState(() => readRightPanelWidth(browserStorage()))
  const commit = useCallback((next: number) => {
    const container = panelRef.current?.parentElement?.clientWidth ?? window.innerWidth
    const clamped = clampRightPanelWidth(next, window.innerWidth, container)
    setWidth(clamped)
    writeRightPanelWidth(browserStorage(), clamped)
  }, [])
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current
    if (event.button !== 0 || panel === null) return
    event.preventDefault()
    const handle = event.currentTarget
    const startX = event.clientX
    const startWidth = panel.getBoundingClientRect().width
    const container = panel.parentElement?.clientWidth ?? window.innerWidth
    let latest = startWidth
    handle.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent) => {
      latest = clampRightPanelWidth(startWidth + startX - moveEvent.clientX, window.innerWidth, container)
      panel.style.width = `${latest}px`
    }
    const finish = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', finish)
      handle.removeEventListener('pointercancel', finish)
      commit(latest)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', finish)
    handle.addEventListener('pointercancel', finish)
  }
  return (
    <aside
      ref={panelRef}
      aria-label="Right panel"
      data-slot="workspace-right-panel"
      data-maximized={maximized || undefined}
      className={cn(
        'border-border bg-background relative h-full min-h-0 flex-col border-l',
        maximized ? 'min-w-0 flex-1' : 'shrink-0',
      )}
      style={{
        display: open ? 'flex' : 'none',
        ...(maximized ? {} : { width, minWidth: RIGHT_PANEL_MIN_WIDTH, maxWidth: 'min(70vw, calc(100% - 360px))' }),
      }}
    >
      {!maximized && (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-label="Resize right panel"
          aria-valuemin={RIGHT_PANEL_MIN_WIDTH}
          aria-valuenow={width}
          onPointerDown={startResize}
          onKeyDown={event => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
              event.preventDefault()
              commit(width + (event.key === 'ArrowLeft' ? KEYBOARD_RESIZE_STEP : -KEYBOARD_RESIZE_STEP))
            }
          }}
          className="hover:bg-primary/30 focus-visible:bg-primary/40 absolute inset-y-0 -left-0.5 z-10 w-1 cursor-col-resize touch-none outline-none"
        />
      )}
      {children}
    </aside>
  )
}

/**
 * Bumps the revision once per refreshKey change and once per window focus, each debounced. Callers reload
 * their data when the revision changes, and the refresh button bumps it immediately.
 */
function useInspectionRevision(open: boolean, refreshKey: number) {
  const [revision, setRevision] = useState(0)
  const bump = useCallback(() => setRevision(value => value + 1), [])
  const lastRefreshKey = useRef(refreshKey)

  useEffect(() => {
    if (lastRefreshKey.current === refreshKey) return
    lastRefreshKey.current = refreshKey
    const timer = window.setTimeout(bump, REFRESH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [refreshKey, bump])

  useEffect(() => {
    if (!open) return
    let timer: number | undefined
    const onFocus = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(bump, REFRESH_DEBOUNCE_MS)
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('watchtower:checkout-files-changed', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('watchtower:checkout-files-changed', onFocus)
      window.clearTimeout(timer)
    }
  }, [open, bump])

  return { revision, refresh: bump }
}

/** Inline placement needs the wide layout; narrower windows use the sheet. */
function useWideViewport(): boolean {
  const query = `(min-width: ${RIGHT_PANEL_WIDE_BREAKPOINT}px)`
  const [wide, setWide] = useState(() =>
    typeof window === 'undefined' || typeof window.matchMedia !== 'function' ? true : window.matchMedia(query).matches,
  )
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const media = window.matchMedia(query)
    const update = () => setWide(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return wide
}
