import { useEffect, useRef, useState } from 'react'

import { useThemeEffect } from '@/app/hooks/use-theme-effect'
import { TooltipProvider } from '@/shared/components/ui/tooltip'
import { cn } from '@/shared/lib/utils'

import { ORB_SIZE } from '../../../shared/schemas/orb.js'
import { useOrbBootstrap } from './hooks'
import { OrbBeacon } from './OrbBeacon'
import { OrbPanel } from './OrbPanel'
import { useOrbStore } from './store'

/** A peek folds itself away after this long unless the pointer rests on it. */
const PEEK_MS = 6000

/**
 * The background orb's composition root (see main/background-shell.ts) —
 * the orb counterpart of AppRoot: bootstrap + theme hooks, then the orb and,
 * when unfolded, its panel. The main process sizes the window; this page only
 * lays the orb out in the corner the store's `placement` names. Every piece
 * of data comes from a store (ADR 0011).
 */
export function OrbApp() {
  useOrbBootstrap()
  useThemeEffect()
  const placement = useOrbStore(s => s.placement)
  const peek = useOrbStore(s => s.peek)
  const setExpanded = useOrbStore(s => s.setExpanded)
  const [hovered, setHovered] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Unfolded, the root takes DOM focus so Escape reaches it even when the
  // panel opened from a summon or a peek rather than a click. Focusing an
  // element never activates the window itself: a peek still steals nothing.
  useEffect(() => {
    if (placement.expanded) rootRef.current?.focus({ preventScroll: true })
  }, [placement.expanded])

  useEffect(() => {
    if (!peek || hovered) return
    const timer = window.setTimeout(() => void setExpanded(false), PEEK_MS)
    return () => window.clearTimeout(timer)
  }, [peek, hovered, setExpanded])

  const bottom = placement.vertical === 'bottom'

  return (
    <TooltipProvider delay={300}>
      <div
        ref={rootRef}
        tabIndex={-1}
        className="text-foreground relative h-full w-full font-sans outline-none"
        onKeyDown={event => {
          if (event.key === 'Escape' && placement.expanded) void setExpanded(false)
        }}
      >
        {placement.expanded && (
          <div
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            className={cn('absolute inset-x-1 flex', bottom ? 'top-1 origin-bottom' : 'bottom-1 origin-top')}
            style={{ height: `calc(100% - ${ORB_SIZE + 10}px)` }}
          >
            <OrbPanel className="h-full w-full" />
          </div>
        )}
        <OrbBeacon
          className={cn(
            'absolute',
            placement.horizontal === 'right' ? 'right-0' : 'left-0',
            bottom ? 'bottom-0' : 'top-0',
          )}
        />
      </div>
    </TooltipProvider>
  )
}
