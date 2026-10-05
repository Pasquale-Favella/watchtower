import { type PointerEvent as ReactPointerEvent, useEffect, useRef } from 'react'

import { useScanStore } from '@/app/stores/scan-store'
import { subscribeToIpc, subscribeToOrbIpc } from '@/app/stores/subscribe'
import { useSettingsStore } from '@/features/settings/store'
import { fetchOrbPlacement, fetchScanStatus, orbControls } from '@/shared/lib/api'

import { useOrbStore } from './store'

/** The orb's bootstrap — the counterpart of `useAppBootstrap`: the shared IPC
 * wiring (scan lifecycle, store:changed tick, currency) plus the orb's own,
 * then hydration. It never fires the first scan: the main window owns that. */
export function useOrbBootstrap(): void {
  useEffect(() => {
    const unsubscribe = subscribeToIpc()
    const unsubscribeOrb = subscribeToOrbIpc()
    void (async () => {
      const status = await fetchScanStatus()
      if (status.ok && status.data.scanned) {
        useScanStore.setState({ hydrated: true })
        await useScanStore.getState().applyChange()
      }
      const placement = await fetchOrbPlacement()
      if (placement.ok && placement.data) useOrbStore.getState().onPlacement(placement.data)
      await Promise.all([useSettingsStore.getState().loadCurrency(), useOrbStore.getState().whenLoaded()])
    })()
    return () => {
      unsubscribe()
      unsubscribeOrb()
    }
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
