import { RefreshCw, X } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { SegTabs } from '@/renderer/components/SegTabs'
import { Button } from '@/renderer/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/renderer/components/ui/sheet'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/renderer/components/ui/tooltip'
import type { CheckoutScope } from '@/shared/schemas/checkout-inspection.js'
import type { ProjectId, WorkspaceCheckoutId } from '@/shared/schemas/workspace.js'

import { DiffTab } from './DiffTab.js'
import { FilesTab } from './FilesTab.js'
import {
  browserStorage,
  checkoutScope,
  clampRightPanelWidth,
  readRightPanelWidth,
  RIGHT_PANEL_MIN_WIDTH,
  RIGHT_PANEL_WIDE_BREAKPOINT,
  type RightPanelTab,
  writeRightPanelWidth,
} from './right-panel-state.js'

const REFRESH_DEBOUNCE_MS = 250
const KEYBOARD_RESIZE_STEP = 16
const TABS = [
  { value: 'diff', label: 'Diff' },
  { value: 'files', label: 'Files' },
]

export interface WorkspaceRightPanelProps {
  readonly projectId: ProjectId
  /** Omitted for the Project's main checkout. */
  readonly checkoutId?: WorkspaceCheckoutId | undefined
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  /** Controlled by `useRightPanel`. When omitted, the panel keeps the tab itself. */
  readonly tab?: RightPanelTab | undefined
  readonly onTabChange?: ((tab: RightPanelTab) => void) | undefined
  /** Bump when a Run completes; the panel reloads its data after a short debounce. */
  readonly refreshKey: number
  readonly onReferencePath: (path: string) => void
}

/**
 * Changes and files for the selected Task's checkout. It sits beside the chat when the window is wide
 * enough, and opens as a right sheet otherwise. The width drag is applied to the DOM during the gesture
 * and committed to state and storage on pointer-up.
 */
export function WorkspaceRightPanel(props: WorkspaceRightPanelProps) {
  const { projectId, checkoutId, open, onOpenChange, refreshKey, onReferencePath } = props
  const wide = useWideViewport()
  const [localTab, setLocalTab] = useState<RightPanelTab>('diff')
  const tab = props.tab ?? localTab
  const setTab = props.onTabChange ?? setLocalTab
  const { revision, refresh } = useInspectionRevision(open, refreshKey)
  const scope = checkoutScope(projectId, checkoutId)
  const close = () => onOpenChange(false)
  const content = (
    <PanelContent
      tab={tab}
      onTabChange={setTab}
      scope={scope}
      revision={revision}
      onRefresh={refresh}
      onClose={close}
      onReferencePath={onReferencePath}
    />
  )
  if (!open) return null
  if (!wide) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="right" showCloseButton={false} className="w-[min(560px,92vw)] gap-0 p-0 sm:max-w-none">
          <SheetTitle className="sr-only">Changes and files</SheetTitle>
          {content}
        </SheetContent>
      </Sheet>
    )
  }
  return <InlinePanel>{content}</InlinePanel>
}

/** Inline placement with a left-edge drag handle. The stored width is clamped again by the CSS limits. */
function InlinePanel({ children }: { readonly children: React.ReactNode }) {
  const panelRef = useRef<HTMLElement | null>(null)
  const [width, setWidth] = useState(() => readRightPanelWidth(browserStorage()))

  const commit = useCallback((next: number) => {
    const container = containerWidthOf(panelRef.current)
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
    const container = containerWidthOf(panel)
    let latest = clampRightPanelWidth(startWidth, window.innerWidth, container)
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

  const onResizeKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      commit(width + KEYBOARD_RESIZE_STEP)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      commit(width - KEYBOARD_RESIZE_STEP)
    }
  }

  return (
    <aside
      ref={panelRef}
      aria-label="Changes and files"
      data-slot="workspace-right-panel"
      className="border-border bg-background relative flex h-full min-h-0 shrink-0 flex-col border-l"
      style={{ width, minWidth: RIGHT_PANEL_MIN_WIDTH, maxWidth: 'min(70vw, calc(100% - 360px))' }}
    >
      <div
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label="Resize changes panel"
        aria-valuemin={RIGHT_PANEL_MIN_WIDTH}
        aria-valuenow={width}
        onPointerDown={startResize}
        onKeyDown={onResizeKey}
        className="hover:bg-primary/30 focus-visible:bg-primary/40 absolute inset-y-0 -left-0.5 z-10 w-1 cursor-col-resize touch-none outline-none"
      />
      {children}
    </aside>
  )
}

/** The space the panel can fill: its parent's width, or the window when there is no parent. */
function containerWidthOf(panel: HTMLElement | null): number {
  return panel?.parentElement?.clientWidth ?? window.innerWidth
}

interface PanelContentProps {
  readonly tab: RightPanelTab
  readonly onTabChange: (tab: RightPanelTab) => void
  readonly scope: CheckoutScope
  readonly revision: number
  readonly onRefresh: () => void
  readonly onClose: () => void
  readonly onReferencePath: (path: string) => void
}

function PanelContent(props: PanelContentProps) {
  const { tab, scope, revision } = props
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="border-border flex h-10 shrink-0 items-center gap-2 border-b px-2.5">
        <SegTabs
          options={TABS}
          value={tab}
          onChange={value => props.onTabChange(value === 'files' ? 'files' : 'diff')}
        />
        <div className="ml-auto flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={<Button variant="ghost" size="icon-xs" aria-label="Refresh changes" onClick={props.onRefresh} />}
            >
              <RefreshCw />
            </TooltipTrigger>
            <TooltipContent side="bottom">Refresh</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="icon-xs" aria-label="Close changes panel" onClick={props.onClose} />
              }
            >
              <X />
            </TooltipTrigger>
            <TooltipContent side="bottom">Close (Ctrl+Alt+B)</TooltipContent>
          </Tooltip>
        </div>
      </header>
      {tab === 'diff' ? (
        <DiffTab scope={scope} revision={revision} />
      ) : (
        <FilesTab scope={scope} revision={revision} onReferencePath={props.onReferencePath} />
      )}
    </div>
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
    return () => {
      window.removeEventListener('focus', onFocus)
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
