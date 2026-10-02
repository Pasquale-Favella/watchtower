import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import {
  type AnalyticalViews,
  analyticalViewsSchema,
  type DashboardViews,
  dashboardViewsSchema,
} from '../../shared/schemas/views.js'
import type { PricingCatalogue } from '../pipeline/pricing-calculation.js'
import type { ProxyPathConfig } from '../pipeline/proxy-paths.js'
import type { LedgerQueries } from '../store/ledger-ports.js'
import { loadLedgerQuerySnapshotEffect } from '../store/ledger-query-snapshot.js'
import { buildAnalyticalViewsFromSnapshotResult, buildDashboardViewsFromSnapshotResult } from '../views-calculation.js'
import { PricingDiagnostics } from './pricing-diagnostics.js'

export type ViewQueryInputs = { readonly catalogue: PricingCatalogue; readonly proxyPaths: ProxyPathConfig }

export const queryDashboardViews = Effect.fn('queryDashboardViews')(function* (
  input: ViewQueryInputs,
): Effect.fn.Return<DashboardViews, SqlError | Schema.SchemaError, LedgerQueries | PricingDiagnostics> {
  const snapshot = yield* loadLedgerQuerySnapshotEffect(input)
  const result = buildDashboardViewsFromSnapshotResult(snapshot)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(result.unpricedModels)
  return yield* Schema.decodeUnknownEffect(dashboardViewsSchema)(result.value)
})

export const queryAnalyticalViews = Effect.fn('queryAnalyticalViews')(function* (
  input: ViewQueryInputs,
): Effect.fn.Return<AnalyticalViews, SqlError | Schema.SchemaError, LedgerQueries | PricingDiagnostics> {
  const snapshot = yield* loadLedgerQuerySnapshotEffect(input)
  const result = buildAnalyticalViewsFromSnapshotResult(snapshot)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(result.unpricedModels)
  return yield* Schema.decodeUnknownEffect(analyticalViewsSchema)(result.value)
})
