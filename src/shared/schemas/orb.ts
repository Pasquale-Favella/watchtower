import * as Schema from 'effect/Schema'

/**
 * The background orb's wire contract (main ↔ the orb's two windows: the
 * 64px orb itself and its spend panel). Decoded on the renderer side like
 * every other payload-bearing channel (ADR 0005/0034), even though the main
 * process is the only producer.
 */

const writable = Schema.mutableKey

/** Diameter of the orb, in DIPs. The orb window is exactly this and never resizes. */
export const ORB_SIZE = 64

/** The spend panel's own window, in DIPs. */
export const ORB_PANEL_SIZE = { width: 360, height: 320 } as const

/** Whether the panel is open, and which side of it the orb sits on. The
 * panel always opens toward the centre of the display, so an orb parked on
 * the right edge has its panel to the left. */
export const orbPlacementSchema = Schema.Struct({
  expanded: writable(Schema.Boolean),
  horizontal: writable(Schema.Literals(['left', 'right'])),
  vertical: writable(Schema.Literals(['top', 'bottom'])),
})
export type OrbPlacement = Schema.Schema.Type<typeof orbPlacementSchema>

/** What an orb page asks of the panel: `open` (the user's own request — a
 * click — so it takes focus), `peek` (opens without taking focus), `fold`. */
export const orbPanelRequestSchema = Schema.Literals(['open', 'peek', 'fold'])
export type OrbPanelRequest = Schema.Schema.Type<typeof orbPanelRequestSchema>

/** One-off nudges from the main process to the panel page: `backgrounded`
 * after the main window was first closed to the tray (it peeks, with a note,
 * once its data is in). */
export const orbNoticeSchema = Schema.Struct({
  kind: writable(Schema.Literals(['backgrounded'])),
})
export type OrbNotice = Schema.Schema.Type<typeof orbNoticeSchema>
