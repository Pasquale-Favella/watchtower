import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/sql/SqlError'

import { type SpendPayload, spendPayloadSchema } from '../../../shared/schemas/spend.js'
import { overviewQueryRanges } from '../../domain/sessions/overview-scope.js'
import { calculateSpendView } from '../../analytics/projections/spend-calculation.js'
import type { LedgerQueries } from '../../ports/repository.js'
import { loadLedgerQuerySnapshotEffect } from './ledger-query-snapshot.js'
import { PricingDiagnostics } from '../../ports/pricing-diagnostics.js'
import type { ScopedViewQueryInputs } from './view-queries.js'

export const querySpendView = Effect.fn('querySpendView')(function* (
  input: ScopedViewQueryInputs,
): Effect.fn.Return<SpendPayload, SqlError | Schema.SchemaError, LedgerQueries | PricingDiagnostics> {
  const now = DateTime.toDateUtc(yield* DateTime.now)
  const { readRange } = overviewQueryRanges(input.scope, now)
  const snapshot = yield* loadLedgerQuerySnapshotEffect(input, readRange)
  const result = calculateSpendView(snapshot, input.scope, now)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(result.unpricedModels)
  return yield* Schema.decodeUnknownEffect(spendPayloadSchema)(result.value)
})
