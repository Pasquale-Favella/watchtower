import { useEffect, useRef, useState } from 'react'

import { useThemeEffect } from '@/app/hooks/use-theme-effect'
import { TooltipProvider } from '@/shared/components/ui/tooltip'
import { orbControls } from '@/shared/lib/api'

import { OrbPanel } from './OrbPanel'
import { useOrbPanelBootstrap } from './panel-hooks'
import { useOrbPanelStore } from './panel-store'
import { useOrbPlacementStore } from './placement-store'

/** A peek folds itself away after this long unless the pointer rests on it. */
const PEEK_MS = 6000

/**
 * The panel window's composition root (see main/background-shell.ts): the
 * spend panel, filling its own window beside the orb. The main process
 * shows, hides and places the window; this page keeps it rendered while
 * hidden, so opening it is instant. Every piece of data comes from a store
 * (ADR 0011).
 */
export function OrbPanelApp() {
  useOrbPanelBootstrap()
  useThemeEffect()
  const expanded = useOrbPlacementStore(s => s.placement.expanded)
  const setExpanded = useOrbPlacementStore(s => s.setExpanded)
  const peek = useOrbPanelStore(s => s.peek)
  const [hovered, setHovered] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!peek || hovered) return
    const timer = window.setTimeout(() => void setExpanded(false), PEEK_MS)
    return () => window.clearTimeout(timer)
  }, [peek, hovered, setExpanded])

  // Open, the root takes DOM focus so Escape reaches it (focusing an element
  // never activates the window: a peek still steals nothing). Then, once a
  // fresh frame is on screen — two animation frames — tell the main process,
  // which reveals the window it showed transparent (no stale-frame flicker).
  useEffect(() => {
    if (!expanded) return
    rootRef.current?.focus({ preventScroll: true })
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => orbControls.panelPainted())
    })
    return () => cancelAnimationFrame(frame)
  }, [expanded])

  return (
    <TooltipProvider delay={300}>
      <div
        ref={rootRef}
        tabIndex={-1}
        className="text-foreground h-full w-full p-1 font-sans outline-none"
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
        onKeyDown={event => {
          if (event.key === 'Escape' && expanded) void setExpanded(false)
        }}
      >
        <OrbPanel className="h-full w-full" />
      </div>
    </TooltipProvider>
  )
}
