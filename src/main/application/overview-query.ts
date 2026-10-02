import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import { type OverviewPayload, overviewPayloadSchema } from '../../shared/schemas/overview.js'
import { calculateOverviewFromSnapshot } from '../overview-calculation.js'
import type { LocalModelSavings } from '../pipeline/pricing-calculation.js'
import type { LedgerQueries } from '../store/ledger-ports.js'
import { loadLedgerQuerySnapshotEffect } from '../store/ledger-query-snapshot.js'
import { PricingDiagnostics } from './pricing-diagnostics.js'
import type { ScopedViewQueryInputs } from './view-queries.js'

export type OverviewQueryInputs = ScopedViewQueryInputs & { readonly localSavings: LocalModelSavings }

export const queryOverview = Effect.fn('queryOverview')(function* (
  input: OverviewQueryInputs,
): Effect.fn.Return<OverviewPayload, SqlError | Schema.SchemaError, LedgerQueries | PricingDiagnostics> {
  const now = DateTime.toDateUtc(yield* DateTime.now)
  const snapshot = yield* loadLedgerQuerySnapshotEffect(input)
  const result = calculateOverviewFromSnapshot(snapshot, input.scope, now, input.localSavings)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(result.unpricedModels)
  return yield* Schema.decodeUnknownEffect(overviewPayloadSchema)(result.value)
})
