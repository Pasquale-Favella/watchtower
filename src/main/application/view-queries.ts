import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import {
  type AnalyticalViews,
  analyticalViewsSchema,
  type DashboardViews,
  dashboardViewsSchema,
} from '../../shared/schemas/views.js'
import type { LedgerQueries } from '../store/ledger-repository.js'
import { loadLedgerQuerySnapshotEffect } from '../store/query-snapshot.js'
import { buildAnalyticalViewsFromSnapshot, buildDashboardViewsFromSnapshot } from '../views.js'

export const queryDashboardViews = Effect.fn('queryDashboardViews')(function* (): Effect.fn.Return<
  DashboardViews,
  SqlError | Schema.SchemaError,
  LedgerQueries
> {
  const snapshot = yield* loadLedgerQuerySnapshotEffect()
  return yield* Schema.decodeUnknownEffect(dashboardViewsSchema)(buildDashboardViewsFromSnapshot(snapshot))
})

export const queryAnalyticalViews = Effect.fn('queryAnalyticalViews')(function* (): Effect.fn.Return<
  AnalyticalViews,
  SqlError | Schema.SchemaError,
  LedgerQueries
> {
  const snapshot = yield* loadLedgerQuerySnapshotEffect()
  return yield* Schema.decodeUnknownEffect(analyticalViewsSchema)(buildAnalyticalViewsFromSnapshot(snapshot))
})
