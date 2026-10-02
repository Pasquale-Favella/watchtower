import type { OverviewScope } from '../shared/schemas/overview.js'
import { overviewDateRange } from './overview-scope.js'
import { type SessionRow, sessionRowFromSummary } from './pipeline/session-row.js'
import { buildSessionSummariesFromSnapshotResult } from './store/aggregate-calculation.js'
import type { LedgerQuerySnapshot } from './store/ledger-query-snapshot.js'

export type SessionsCalculationResult = {
  rows: SessionRow[]
  unpricedModels: readonly string[]
}

export function calculateSessionsView(
  snapshot: LedgerQuerySnapshot,
  scope: OverviewScope,
  now: Date,
): SessionsCalculationResult {
  const calculation = buildSessionSummariesFromSnapshotResult(snapshot, {
    range: overviewDateRange(scope, now),
    provider: scope.provider,
  })
  const rows = calculation.summaries
    .map(summary => sessionRowFromSummary(summary, summary.project))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))

  return { rows, unpricedModels: calculation.unpricedModels }
}
