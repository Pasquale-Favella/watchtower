/**
 * The background orb's pure decisions — no Electron here, so they are unit
 * tested directly (tests/orb-policy.test.ts). The shell (background-shell.ts)
 * owns the windows and calls these for the parts that are easy to get wrong:
 * screen-space hit-testing, an open that arrives before the orb is on screen,
 * and the once-per-session "still watching" peek.
 */

/** A screen position in DIPs — the orb's anchor is its circle's top-left. */
export interface Point {
  x: number
  y: number
}

export interface Rect extends Point {
  width: number
  height: number
}

/** The anchor `dx`/`dy` away from `origin` (a drag), in whole DIPs. */
export function offsetAnchor(origin: Point, dx: number, dy: number): Point {
  return { x: Math.round(origin.x + dx), y: Math.round(origin.y + dy) }
}

/** Whether `point` lies inside `rect` (right/bottom edges exclusive). */
export function containsPoint(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height
}

/** An open the shell could not apply yet (the orb is still on its way to the
 * screen), held so it is applied when the orb shows — but only briefly: a
 * request older than `ttlMs` is stale (the user has moved on) and is dropped
 * rather than replayed minutes later. */
export interface HeldRequest<T> {
  hold: (request: T) => void
  /** The held request if still fresh, else null; either way it is consumed. */
  take: () => T | null
  clear: () => void
}

export function createHeldRequest<T>(ttlMs: number, now: () => number = Date.now): HeldRequest<T> {
  let held: { request: T; at: number } | null = null
  return {
    hold: request => {
      held = { request, at: now() }
    },
    take: () => {
      const current = held
      held = null
      return current && now() - current.at <= ttlMs ? current.request : null
    },
    clear: () => {
      held = null
    },
  }
}

/** The first-close peek fires once per session, and only when BOTH have
 * happened, in either order: the main window was closed to the tray with the
 * orb on, and the panel reported its data loaded (so it never opens onto
 * skeletons). Each mark returns whether the peek should open now. */
export interface PeekGate {
  closed: () => boolean
  dataReady: () => boolean
}

export function createPeekGate(): PeekGate {
  let closed = false
  let ready = false
  let fired = false
  const due = (): boolean => {
    if (fired || !closed || !ready) return false
    fired = true
    return true
  }
  return {
    closed: () => {
      closed = true
      return due()
    },
    dataReady: () => {
      ready = true
      return due()
    },
  }
}
