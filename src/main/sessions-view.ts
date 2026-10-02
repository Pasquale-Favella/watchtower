import * as Schema from 'effect/Schema'

import type { OverviewScope } from '../shared/schemas/overview.js'
import { type SessionRow, sessionRowSchema } from '../shared/schemas/views.js'
import { reportUnpricedModels } from './pipeline/pricing-diagnostics.js'
import { calculateSessionsView } from './sessions-calculation.js'
import type { LedgerStore } from './store/ledger.js'
import { loadLedgerQuerySnapshot } from './store/query-snapshot.js'

export type { SessionRow } from '../shared/schemas/views.js'

/**
 * The Sessions section's scoped row list (ADR 0008): the same period /
 * custom-range / provider scope as the Overview's `overview:query`, mapped
 * onto the aggregation seam, which filters the loaded snapshot by date and
 * provider (sessions count by their in-range turns), then already-shaped
 * `SessionRow[]`, newest-first. Kept in the main process so the sandboxed
 * renderer only receives serializable rows over IPC.
 */
export function buildSessionsViewFromLedger(store: LedgerStore, scope: OverviewScope, now = new Date()): SessionRow[] {
  const snapshot = loadLedgerQuerySnapshot(store)
  const result = calculateSessionsView(snapshot, scope, now)
  reportUnpricedModels(result.unpricedModels)
  return Schema.decodeUnknownSync(Schema.mutable(Schema.Array(sessionRowSchema)))(result.rows)
}
