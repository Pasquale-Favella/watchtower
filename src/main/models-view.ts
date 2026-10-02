import * as Schema from 'effect/Schema'

import { type ModelsConfig, type ModelsPayload, modelsPayloadSchema } from '../shared/schemas/models.js'
import type { OverviewScope } from '../shared/schemas/overview.js'
import { calculateModelsPayload } from './models-calculation.js'
import { overviewDateRange } from './overview-scope.js'
import { reportUnpricedModels } from './pipeline/pricing-diagnostics.js'
import { buildSessionSummariesFromSnapshotResult } from './store/aggregate-calculation.js'
import type { LedgerStore } from './store/ledger.js'
import { loadLedgerQuerySnapshot } from './store/query-snapshot.js'

export type { AuditRow, ModelReportRow, ModelsConfig, ModelsPayload, RowOverride } from '../shared/schemas/models.js'

/** Compatibility adapter for existing MCP and test callers. */
export function buildModelsViewFromLedger(
  store: LedgerStore,
  scope: OverviewScope,
  config: ModelsConfig,
  now = new Date(),
): ModelsPayload {
  const snapshot = loadLedgerQuerySnapshot(store)
  const calculation = buildSessionSummariesFromSnapshotResult(snapshot, {
    range: overviewDateRange(scope, now),
    provider: scope.provider,
  })
  reportUnpricedModels(calculation.unpricedModels)
  return Schema.decodeUnknownSync(modelsPayloadSchema)(
    calculateModelsPayload(calculation.summaries, config, snapshot.catalogue),
  )
}
