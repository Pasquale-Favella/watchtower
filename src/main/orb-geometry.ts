import { screen } from 'electron'

import { ORB_PANEL_SIZE, ORB_SIZE, type OrbPlacement } from '../shared/schemas/orb.js'
import type { Point } from './orb-policy.js'

/** Gap kept between the orb and the work-area edge. */
const EDGE_MARGIN = 12

/** Gap between the orb and its panel window. */
const PANEL_GAP = 8

function workAreaAround(anchor: Point): Electron.Rectangle {
  return screen.getDisplayNearestPoint({
    x: Math.round(anchor.x + ORB_SIZE / 2),
    y: Math.round(anchor.y + ORB_SIZE / 2),
  }).workArea
}

function clampInto(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), max))
}

/** Keeps the orb fully on the display it is closest to. */
export function clampToWorkArea(anchor: Point): Point {
  const area = workAreaAround(anchor)
  return {
    x: clampInto(anchor.x, area.x + EDGE_MARGIN, area.x + area.width - ORB_SIZE - EDGE_MARGIN),
    y: clampInto(anchor.y, area.y + EDGE_MARGIN, area.y + area.height - ORB_SIZE - EDGE_MARGIN),
  }
}

/** First-run spot: the primary display's bottom-right corner. */
export function defaultOrbPosition(): Point {
  const area = screen.getPrimaryDisplay().workArea
  return {
    x: area.x + area.width - ORB_SIZE - EDGE_MARGIN * 2,
    y: area.y + area.height - ORB_SIZE - EDGE_MARGIN * 6,
  }
}

/** The orb window's bounds: always exactly the orb. It never resizes — a
 * resize that moves the window's origin repaints the old frame at the new
 * origin for one frame, which reads as the orb jumping. */
export function orbBounds(anchor: Point): Electron.Rectangle {
  return { ...anchor, width: ORB_SIZE, height: ORB_SIZE }
}

/** The panel window's bounds beside the orb at `anchor`: it opens toward the
 * display's centre (above an orb parked low, left of an orb parked right) so
 * it never runs off the edge the orb sits on, and is clamped onto the display.
 * `placement` says which side of the panel the orb is on, and whether the
 * open is a peek (`peek`). */
export function panelLayout(
  anchor: Point,
  expanded: boolean,
  peek = false,
): { bounds: Electron.Rectangle; placement: OrbPlacement } {
  const area = workAreaAround(anchor)
  const onRight = anchor.x + ORB_SIZE / 2 > area.x + area.width / 2
  const onBottom = anchor.y + ORB_SIZE / 2 > area.y + area.height / 2
  const { width, height } = ORB_PANEL_SIZE
  return {
    bounds: {
      x: clampInto(onRight ? anchor.x + ORB_SIZE - width : anchor.x, area.x, area.x + area.width - width),
      y: clampInto(
        onBottom ? anchor.y - PANEL_GAP - height : anchor.y + ORB_SIZE + PANEL_GAP,
        area.y,
        area.y + area.height - height,
      ),
      width,
      height,
    },
    placement: {
      expanded,
      peek: expanded && peek,
      horizontal: onRight ? 'right' : 'left',
      vertical: onBottom ? 'bottom' : 'top',
    },
  }
}
