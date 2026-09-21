import { querySessionPage, type SessionQuery } from '../shared/lib/sessions-query.js'
import { type SessionPageResult, sessionPageResultSchema } from '../shared/schemas/views.js'
import { overviewDateRange, type OverviewScope } from './overview.js'
import { buildSessionRows } from './store/aggregate.js'
import type { LedgerStore } from './store/ledger.js'

export type { SessionPageResult } from '../shared/schemas/views.js'
export type { SessionQuery } from '../shared/lib/sessions-query.js'

/**
 * The Sessions section's server-paged row list (#139 scope 3, #141 item 2):
 * the same period / custom-range / provider scope as `buildSessionsViewFromLedger`,
 * mapped onto the aggregation seam whose range and provider filters apply at
 * the SQL read — then searched, sorted, and sliced HERE, in the main process,
 * so only one page plus totals crosses IPC. The renderer drives this through
 * the `sessions:page` channel and never holds the full scoped set (one paging
 * layer, not two: the renderer's local pager slices nothing).
 *
 * Request scopes are typed, not zod-validated (ADR 0008) — garbage
 * normalizes to the defaults instead of throwing. Keyset `cursor` and
 * `offset` random access compose per `querySessionPage`: a valid cursor whose
 * sort matches wins (stable continuation under background refresh), otherwise
 * the offset applies (the numbered pager). Out-of-range offsets clamp to the
 * last page server-side.
 *
 * Main-memory note: the SQL-bounded scoped set still assembles transiently
 * per request (cost/tokens sorts need query-time pricing assembly, so they
 * cannot page before aggregation). Bounding lifetime-scale main memory is
 * the materialized-views question, tracked separately — this channel bounds
 * the IPC payload, renderer memory, and mounted DOM instead.
 */
export function buildSessionsPageFromLedger(
  store: LedgerStore,
  scope: OverviewScope,
  now = new Date(),
  query: SessionQuery = {},
): SessionPageResult {
  const rows = buildSessionRows(store, { range: overviewDateRange(scope, now), provider: scope.provider })
  return sessionPageResultSchema.parse(querySessionPage(rows, query))
}
