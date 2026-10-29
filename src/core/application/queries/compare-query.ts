import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/sql/SqlError'

import { type ComparePair, type ComparePayload, comparePayloadSchema } from '../../../shared/schemas/compare.js'
import { calculateComparePayload } from '../../analytics/projections/compare-calculation.js'
import { overviewQueryRanges } from '../../domain/sessions/overview-scope.js'
import { buildSessionSummariesFromSnapshotResult } from '../../analytics/projections/aggregate-calculation.js'
import type { LedgerQueries } from '../../ports/repository.js'
import { loadLedgerQuerySnapshotEffect } from './ledger-query-snapshot.js'
import { PricingDiagnostics } from '../../ports/pricing-diagnostics.js'
import type { ScopedViewQueryInputs } from './view-queries.js'

export type CompareQueryInputs = ScopedViewQueryInputs & { readonly pair?: ComparePair }

export const queryCompareView = Effect.fn('queryCompareView')(function* (
  input: CompareQueryInputs,
): Effect.fn.Return<ComparePayload, SqlError | Schema.SchemaError, LedgerQueries | PricingDiagnostics> {
  const now = DateTime.toDateUtc(yield* DateTime.now)
  const { range, readRange } = overviewQueryRanges(input.scope, now)
  const snapshot = yield* loadLedgerQuerySnapshotEffect(input, readRange)
  const calculation = buildSessionSummariesFromSnapshotResult(snapshot, {
    range,
    provider: input.scope.provider,
  })
  const payload = calculateComparePayload(calculation.summaries, snapshot.catalogue, input.pair)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(calculation.unpricedModels)
  return yield* Schema.decodeUnknownEffect(comparePayloadSchema)(payload)
})
