import { buildSessionRows } from './store/aggregate.js'
import { overviewDateRange, type OverviewScope } from './overview.js'
import type { LedgerStore } from './store/ledger.js'
import { clampInt } from '../shared/lib/clamp.js'
import { sessionRowSchema, type SessionRow } from '../shared/schemas/views.js'

export type { SessionRow } from '../shared/schemas/views.js'

/** One page through the Sessions row list (#139): `LIMIT`/`OFFSET` over the
 * newest-first rows. Request scopes are typed, not zod-validated (ADR 0008) —
 * garbage normalizes to the defaults instead of throwing, mirroring the
 * skills-threshold tripwire. */
export interface SessionPage {
  limit?: unknown
  offset?: unknown
}

/** Upper bound for one page: keeps a single IPC payload small while staying
 * far above the renderer's 100-row mount page. A page without an explicit
 * limit takes the whole cap (the no-page call still returns the full scoped
 * list for backward compatibility). */
export const SESSIONS_VIEW_MAX_LIMIT = 500

export function normalizeSessionPage(page: SessionPage | undefined): { limit: number; offset: number } {
  return {
    limit: clampInt(page?.limit, SESSIONS_VIEW_MAX_LIMIT, 1, SESSIONS_VIEW_MAX_LIMIT),
    offset: clampInt(page?.offset, 0, 0, Number.MAX_SAFE_INTEGER),
  }
}

/**
 * The Sessions section's scoped row list (ADR 0008): the same period /
 * custom-range / provider scope as the Overview's `overview:query`, mapped
 * onto the aggregation seam whose range and provider filters apply at the SQL
 * read (sessions count by their in-range turns), then already-shaped
 * `SessionRow[]`, newest-first, sliced to the requested page. Without a page
 * the full scoped list returns (the renderer's local pager slices it); with
 * one, only that window crosses IPC. Kept in the main process so the
 * sandboxed renderer only receives serializable rows over IPC.
 */
export function buildSessionsViewFromLedger(
  store: LedgerStore,
  scope: OverviewScope,
  now = new Date(),
  page?: SessionPage,
): SessionRow[] {
  const rows = buildSessionRows(store, { range: overviewDateRange(scope, now), provider: scope.provider })
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
  if (page === undefined) return sessionRowSchema.array().parse(rows)
  const { limit, offset } = normalizeSessionPage(page)
  return sessionRowSchema.array().parse(rows.slice(offset, offset + limit))
}
