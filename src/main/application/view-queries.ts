import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import type { OverviewScope } from '../../shared/schemas/overview.js'
import {
  type AnalyticalViews,
  analyticalViewsSchema,
  type DashboardViews,
  dashboardViewsSchema,
} from '../../shared/schemas/views.js'
import { LedgerViewReads } from '../store/ledger-view-reads.js'
import {
  calculateAnalyticalViews,
  calculateDashboardViews,
  type ViewCalculationInputs,
} from '../view-aggregate-calculation.js'
import { PricingDiagnostics } from './pricing-diagnostics.js'

export type ViewQueryInputs = ViewCalculationInputs
export type ScopedViewQueryInputs = ViewQueryInputs & { readonly scope: OverviewScope }

export const queryDashboardViews = Effect.fn('queryDashboardViews')(function* (
  input: ViewQueryInputs,
): Effect.fn.Return<DashboardViews, SqlError | Schema.SchemaError, LedgerViewReads | PricingDiagnostics> {
  const reads = yield* LedgerViewReads
  const data = yield* reads.getViewData()
  const result = calculateDashboardViews(data, input)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(result.unpricedModels)
  return yield* Schema.decodeUnknownEffect(dashboardViewsSchema)(result.value)
})

export const queryAnalyticalViews = Effect.fn('queryAnalyticalViews')(function* (
  input: ViewQueryInputs,
): Effect.fn.Return<AnalyticalViews, SqlError | Schema.SchemaError, LedgerViewReads | PricingDiagnostics> {
  const reads = yield* LedgerViewReads
  const data = yield* reads.getViewData()
  const result = calculateAnalyticalViews(data, input)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(result.unpricedModels)
  return yield* Schema.decodeUnknownEffect(analyticalViewsSchema)(result.value)
})
