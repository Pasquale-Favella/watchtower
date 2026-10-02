import * as Schema from 'effect/Schema'

import type { OverviewScope } from '../shared/schemas/overview.js'
import { type PullRequestsPayload, pullRequestsPayloadSchema } from '../shared/schemas/pull-requests.js'
import { overviewDateRange } from './overview-scope.js'
import { reportUnpricedModels } from './pipeline/pricing-diagnostics.js'
import { calculatePullRequestsPayload } from './pull-requests-calculation.js'
import { buildSessionSummariesFromSnapshotResult } from './store/aggregate-calculation.js'
import type { LedgerStore } from './store/ledger.js'
import { loadLedgerQuerySnapshot } from './store/query-snapshot.js'

export type { PullRequestRow, PullRequestsPayload } from '../shared/schemas/pull-requests.js'

/** Compatibility builder. Scoped summaries retain PR carry and subagent
 * attribution, including legacy session-level estimates without categories. */
export function buildPullRequestsViewFromLedger(
  store: LedgerStore,
  scope: OverviewScope,
  now = new Date(),
): PullRequestsPayload {
  const snapshot = loadLedgerQuerySnapshot(store)
  const calculation = buildSessionSummariesFromSnapshotResult(snapshot, {
    range: overviewDateRange(scope, now),
    provider: scope.provider,
  })
  reportUnpricedModels(calculation.unpricedModels)
  return Schema.decodeUnknownSync(pullRequestsPayloadSchema)(
    calculatePullRequestsPayload(calculation.summaries, snapshot.catalogue),
  )
}
