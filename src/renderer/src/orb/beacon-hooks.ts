import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from 'react'

import { useScanStore } from '@/app/stores/scan-store'
import { orbControls } from '@/shared/lib/api'

import { subscribeToOrbBeacon } from './beacon-wiring'
import { useOrbPlacementStore } from './placement-store'

/** The orb window's bootstrap: its light wiring, then the two things it
 * shows — where it sits and whether a scan is running (asked once, so an orb
 * that appears mid-scan spins at once; the lifecycle broadcasts take over). */
export function useOrbBeaconBootstrap(): void {
  useEffect(() => {
    const unsubscribe = subscribeToOrbBeacon()
    void useOrbPlacementStore.getState().sync()
    void useScanStore.getState().syncActivity()
    return unsubscribe
  }, [])
}

const DRAG_THRESHOLD_PX = 4

/** Pointer handling for the orb: a press that travels past the threshold
 * drags the window (the main process moves it — the page only reports the
 * screen-space delta, one IPC per frame); anything shorter is a click. */
export function useOrbDrag(onClick: () => void): {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: () => void
} {
  const drag = useRef<{ x: number; y: number; moving: boolean; frame: number } | null>(null)

  return {
    onPointerDown: event => {
      if (event.button !== 0) return
      event.currentTarget.setPointerCapture(event.pointerId)
      drag.current = { x: event.screenX, y: event.screenY, moving: false, frame: 0 }
    },
    onPointerMove: event => {
      const state = drag.current
      if (!state) return
      const dx = event.screenX - state.x
      const dy = event.screenY - state.y
      if (!state.moving) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return
        state.moving = true
        orbControls.dragStart()
      }
      cancelAnimationFrame(state.frame)
      state.frame = requestAnimationFrame(() => orbControls.dragMove(dx, dy))
    },
    onPointerUp: event => {
      const state = drag.current
      drag.current = null
      if (!state) return
      event.currentTarget.releasePointerCapture(event.pointerId)
      if (!state.moving) {
        onClick()
        return
      }
      cancelAnimationFrame(state.frame)
      orbControls.dragMove(event.screenX - state.x, event.screenY - state.y)
      orbControls.dragEnd()
    },
    onPointerCancel: () => {
      if (drag.current?.moving) orbControls.dragEnd()
      drag.current = null
    },
  }
}
