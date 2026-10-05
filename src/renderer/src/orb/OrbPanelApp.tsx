import { useEffect, useRef } from 'react'

import { useThemeEffect } from '@/app/hooks/use-theme-effect'
import { TooltipProvider } from '@/shared/components/ui/tooltip'
import { orbControls } from '@/shared/lib/api'

import { OrbPanel } from './OrbPanel'
import { useOrbPanelBootstrap } from './panel-hooks'
import { useOrbPlacementStore } from './placement-store'

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
  const request = useOrbPlacementStore(s => s.request)
  const rootRef = useRef<HTMLDivElement>(null)

  // Open, the root takes DOM focus, so Escape folds a panel the user opened
  // (a click, the summon shortcut: the window is focused). A peek is shown
  // without focus, so the OS sends it no keys until it is clicked; it folds
  // on its own (the main process's timer) or on a click elsewhere. Focusing
  // an element never activates the window, so a peek still steals nothing.
  //
  // Once a fresh frame is on screen (two animation frames), the page tells
  // the main process, which reveals the window it showed transparent.
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
        onKeyDown={event => {
          if (event.key === 'Escape' && expanded) void request('fold')
        }}
      >
        <OrbPanel className="h-full w-full" />
      </div>
    </TooltipProvider>
  )
}
