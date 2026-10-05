import * as Schema from 'effect/Schema'

/**
 * The app's sections and their route paths (ADR 0014) — the single source of
 * truth. The renderer's app/navigation.ts re-exports these for every nav
 * entry point; they live in shared/ because a `Section` also crosses the wire
 * (the background orb asks the main process to open the app on one).
 */

/** The canonical section order, shared by nav and shortcuts. Mirrors
 * NAV_SECTIONS in app/shortcuts.ts, which stays the registry's own copy
 * (ADR 0001). */
export const SECTIONS = [
  'overview',
  'sessions',
  'pullRequests',
  'spend',
  'optimize',
  'models',
  'compare',
  // Coach & Skills (ADR 0017): one unified surface where every harness run is
  // a free-form coach prompt (coaching or skill authoring, same agent).
  'coachSkills',
  'settings',
] as const

export const sectionSchema = Schema.Literals(SECTIONS)
export type Section = Schema.Schema.Type<typeof sectionSchema>

/** Route paths. The router owns identity; every nav entry point (sidebar,
 * shortcuts, "See all ›", session rows, the orb) routes through here. */
export const ROUTES = {
  overview: '/',
  sessions: '/sessions',
  sessionDetail: (id: string) => `/sessions/${id}`,
  pullRequests: '/pull-requests',
  spend: '/spend',
  optimize: '/optimize',
  models: '/models',
  compare: '/compare',
  coachSkills: '/coach-skills',
  settings: '/settings',
} as const satisfies Record<Section, string> & { sessionDetail: (id: string) => string }
