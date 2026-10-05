import * as Schema from 'effect/Schema'

/**
 * The background orb's wire contract (main ↔ orb renderer). Decoded on the
 * renderer side like every other payload-bearing channel (ADR 0005/0034),
 * even though the main process is the only producer.
 */

const writable = Schema.mutableKey

/** Diameter of the orb, in DIPs. The collapsed orb window is exactly this. */
export const ORB_SIZE = 64

/** The expanded orb window (orb + hint panel), in DIPs. */
export const ORB_PANEL_SIZE = { width: 360, height: 392 } as const

/** Where the orb sits inside its window. The panel always grows toward the
 * centre of the display, so an orb parked on the right edge opens leftwards. */
export const orbPlacementSchema = Schema.Struct({
  expanded: writable(Schema.Boolean),
  horizontal: writable(Schema.Literals(['left', 'right'])),
  vertical: writable(Schema.Literals(['top', 'bottom'])),
})
export type OrbPlacement = Schema.Schema.Type<typeof orbPlacementSchema>

/** One-off nudges from the main process to the orb: `backgrounded` after the
 * main window was closed to the tray, `summoned` after the global shortcut. */
export const orbNoticeSchema = Schema.Struct({
  kind: writable(Schema.Literals(['backgrounded', 'summoned'])),
})
export type OrbNotice = Schema.Schema.Type<typeof orbNoticeSchema>
