import * as Schema from 'effect/Schema'

import type { OverviewScope } from '../shared/schemas/overview.js'
import { type SpendPayload, spendPayloadSchema } from '../shared/schemas/spend.js'
import { reportUnpricedModels } from './pipeline/pricing-diagnostics.js'
import { calculateSpendView } from './spend-calculation.js'
import type { LedgerStore } from './store/ledger.js'
import { loadLedgerQuerySnapshot } from './store/query-snapshot.js'

export type {
  SpendDayEntry,
  SpendFlow,
  SpendFlowLink,
  SpendFlowNode,
  SpendPayload,
  SpendSegment,
} from '../shared/schemas/spend.js'

/** Synchronous compatibility builder for current facade callers. */
export function buildSpendViewFromLedger(store: LedgerStore, scope: OverviewScope, now = new Date()): SpendPayload {
  const snapshot = loadLedgerQuerySnapshot(store)
  const result = calculateSpendView(snapshot, scope, now)
  reportUnpricedModels(result.unpricedModels)
  return Schema.decodeUnknownSync(spendPayloadSchema)(result.value)
}
