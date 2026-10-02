import * as Schema from 'effect/Schema'

import { type OverviewPayload, overviewPayloadSchema, type OverviewScope } from '../shared/schemas/overview.js'
import { calculateOverviewFromSnapshot, calculateOverviewPayload } from './overview-calculation.js'
import { captureLocalModelSavings, captureModelPricingCatalogue } from './pipeline/models.js'
import { reportUnpricedModels } from './pipeline/pricing-diagnostics.js'
import type { SessionSummary } from './pipeline/types.js'
import type { LedgerStore } from './store/ledger.js'
import { loadLedgerQuerySnapshot } from './store/query-snapshot.js'

export type {
  EfficiencyGrade,
  OverviewActivityRow,
  OverviewDailyEntry,
  OverviewEfficiency,
  OverviewKpis,
  OverviewLocalModelSavings,
  OverviewLocalSavingsProviderRow,
  OverviewLocalSavingsRow,
  OverviewMcpRow,
  OverviewModelRow,
  OverviewPayload,
  OverviewPeriod,
  OverviewRetryTax,
  OverviewRetryTaxRow,
  OverviewReworkedFile,
  OverviewRoutingWaste,
  OverviewRoutingWasteRow,
  OverviewScope,
  OverviewSkillRow,
  OverviewSubagentRow,
  OverviewToolRow,
  OverviewUnpricedModel,
  OverviewWorkflow,
} from '../shared/schemas/overview.js'
export { dataStartForSessions, inScope, localDateKey, overviewDateRange, periodWindowStart } from './overview-scope.js'
/** Compatibility adapter for callers that already hold summaries. Pricing
 * state is captured once and passed through the pure payload calculation. */
export function buildOverviewPayload(
  sessions: SessionSummary[],
  scope: OverviewScope,
  now = new Date(),
  dataStart: string | null,
): OverviewPayload {
  const catalogue = captureModelPricingCatalogue()
  const localSavings = captureLocalModelSavings()
  return calculateOverviewPayload({ sessions, scope, now, dataStart, catalogue, localSavings })
}

/** Compatibility adapter for ledger-backed callers. A single captured
 * snapshot supplies both lifetime dataStart and the scoped Overview rows. */
export function buildOverviewFromLedger(store: LedgerStore, scope: OverviewScope, now = new Date()): OverviewPayload {
  const snapshot = loadLedgerQuerySnapshot(store)
  const localSavings = captureLocalModelSavings()
  const result = calculateOverviewFromSnapshot(snapshot, scope, now, localSavings)
  reportUnpricedModels(result.unpricedModels)
  return Schema.decodeUnknownSync(overviewPayloadSchema)(result.value)
}
