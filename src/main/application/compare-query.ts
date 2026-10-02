import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import { type ComparePair, type ComparePayload, comparePayloadSchema } from '../../shared/schemas/compare.js'
import { calculateComparePayload } from '../compare-calculation.js'
import { overviewDateRange } from '../overview-scope.js'
import { buildSessionSummariesFromSnapshotResult } from '../store/aggregate-calculation.js'
import type { LedgerQueries } from '../store/ledger-ports.js'
import { loadLedgerQuerySnapshotEffect } from '../store/ledger-query-snapshot.js'
import { PricingDiagnostics } from './pricing-diagnostics.js'
import type { ScopedViewQueryInputs } from './view-queries.js'

export type CompareQueryInputs = ScopedViewQueryInputs & { readonly pair?: ComparePair }

export const queryCompareView = Effect.fn('queryCompareView')(function* (
  input: CompareQueryInputs,
): Effect.fn.Return<ComparePayload, SqlError | Schema.SchemaError, LedgerQueries | PricingDiagnostics> {
  const now = DateTime.toDateUtc(yield* DateTime.now)
  const snapshot = yield* loadLedgerQuerySnapshotEffect(input)
  const calculation = buildSessionSummariesFromSnapshotResult(snapshot, {
    range: overviewDateRange(input.scope, now),
    provider: input.scope.provider,
  })
  const payload = calculateComparePayload(calculation.summaries, snapshot.catalogue, input.pair)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(calculation.unpricedModels)
  return yield* Schema.decodeUnknownEffect(comparePayloadSchema)(payload)
})
