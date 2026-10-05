import { useEffect, useRef, useState } from 'react'

import { useThemeEffect } from '@/app/hooks/use-theme-effect'
import { TooltipProvider } from '@/shared/components/ui/tooltip'

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

  // Open, the root takes DOM focus so Escape reaches it. Focusing an element
  // never activates the window itself: a peek still steals nothing.
  useEffect(() => {
    if (expanded) rootRef.current?.focus({ preventScroll: true })
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
