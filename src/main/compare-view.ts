import * as Schema from 'effect/Schema'

import { type ComparePair, type ComparePayload, comparePayloadSchema } from '../shared/schemas/compare.js'
import type { OverviewScope } from '../shared/schemas/overview.js'
import { calculateComparePayload } from './compare-calculation.js'
import { overviewDateRange } from './overview-scope.js'
import { reportUnpricedModels } from './pipeline/pricing-diagnostics.js'
import { buildSessionSummariesFromSnapshotResult } from './store/aggregate-calculation.js'
import type { LedgerStore } from './store/ledger.js'
import { loadLedgerQuerySnapshot } from './store/query-snapshot.js'

export type {
  CategoryComparison,
  CompareFormatFn,
  CompareModelStat,
  ComparePair,
  ComparePayload,
  CompareReport,
  CompareWinner,
  ComparisonRow,
  WorkingStyleRow,
} from '../shared/schemas/compare.js'

/** Compatibility adapter for existing MCP and test callers. */
export function buildCompareViewFromLedger(
  store: LedgerStore,
  scope: OverviewScope,
  pair?: ComparePair,
  now = new Date(),
): ComparePayload {
  const snapshot = loadLedgerQuerySnapshot(store)
  const calculation = buildSessionSummariesFromSnapshotResult(snapshot, {
    range: overviewDateRange(scope, now),
    provider: scope.provider,
  })
  reportUnpricedModels(calculation.unpricedModels)
  return Schema.decodeUnknownSync(comparePayloadSchema)(
    calculateComparePayload(calculation.summaries, snapshot.catalogue, pair),
  )
}
