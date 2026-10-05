import { screen } from 'electron'

import { ORB_PANEL_SIZE, ORB_SIZE, type OrbPlacement } from '../shared/schemas/orb.js'

/** A screen position in DIPs — the orb's anchor is its circle's top-left. */
export interface Point {
  x: number
  y: number
}

/** Gap kept between the orb and the work-area edge. */
const EDGE_MARGIN = 12

function workAreaAround(anchor: Point): Electron.Rectangle {
  return screen.getDisplayNearestPoint({
    x: Math.round(anchor.x + ORB_SIZE / 2),
    y: Math.round(anchor.y + ORB_SIZE / 2),
  }).workArea
}

/** Keeps the orb fully on the display it is closest to. */
export function clampToWorkArea(anchor: Point): Point {
  const area = workAreaAround(anchor)
  return {
    x: Math.round(Math.min(Math.max(anchor.x, area.x + EDGE_MARGIN), area.x + area.width - ORB_SIZE - EDGE_MARGIN)),
    y: Math.round(Math.min(Math.max(anchor.y, area.y + EDGE_MARGIN), area.y + area.height - ORB_SIZE - EDGE_MARGIN)),
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

/** Window bounds for the orb at `anchor`. Expanded, the panel grows toward
 * the display's centre so it never runs off the edge the orb is parked on. */
export function orbLayout(anchor: Point, expanded: boolean): { bounds: Electron.Rectangle; placement: OrbPlacement } {
  const area = workAreaAround(anchor)
  const onRight = anchor.x + ORB_SIZE / 2 > area.x + area.width / 2
  const onBottom = anchor.y + ORB_SIZE / 2 > area.y + area.height / 2
  const placement: OrbPlacement = {
    expanded,
    horizontal: onRight ? 'right' : 'left',
    vertical: onBottom ? 'bottom' : 'top',
  }
  if (!expanded) return { bounds: { ...anchor, width: ORB_SIZE, height: ORB_SIZE }, placement }
  const { width, height } = ORB_PANEL_SIZE
  return {
    bounds: {
      x: Math.round(onRight ? anchor.x + ORB_SIZE - width : anchor.x),
      y: Math.round(onBottom ? anchor.y + ORB_SIZE - height : anchor.y),
      width,
      height,
    },
    placement,
  }
}
