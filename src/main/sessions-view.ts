import { buildSessionRows } from './store/aggregate.js'
import { overviewDateRange, type OverviewScope } from './overview.js'
import type { LedgerStore } from './store/ledger.js'
import { sessionRowSchema, type SessionRow } from '../shared/schemas/views.js'

export type { SessionRow } from '../shared/schemas/views.js'

/**
 * The Sessions section's scoped row list (ADR 0008): the same period /
 * custom-range / provider scope as the Overview's `overview:query`, mapped
 * onto the aggregation seam whose range and provider filters apply at the SQL
 * read (sessions count by their in-range turns), then already-shaped
 * `SessionRow[]`, newest-first. Kept in the main process so the sandboxed
 * renderer only receives serializable rows over IPC.
 */
export function buildSessionsViewFromLedger(store: LedgerStore, scope: OverviewScope, now = new Date()): SessionRow[] {
  const rows = buildSessionRows(store, { range: overviewDateRange(scope, now), provider: scope.provider }).sort(
    (a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0),
  )
  return sessionRowSchema.array().parse(rows)
}
