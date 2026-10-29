import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/sql/SqlError'

import { type SessionRow, sessionRowSchema } from '@/shared/schemas/views.js'
import { overviewQueryRanges } from '@/core/domain/sessions/overview-scope.js'
import { calculateSessionsView } from '@/core/analytics/projections/sessions-calculation.js'
import type { LedgerQueries } from '@/core/ports/repository.js'
import { loadLedgerQuerySnapshotEffect } from '@/core/application/queries/ledger-query-snapshot.js'
import { PricingDiagnostics } from '@/core/ports/pricing-diagnostics.js'
import type { ScopedViewQueryInputs } from '@/core/application/queries/view-queries.js'

export const querySessionsView = Effect.fn('querySessionsView')(function* (
  input: ScopedViewQueryInputs,
): Effect.fn.Return<SessionRow[], SqlError | Schema.SchemaError, LedgerQueries | PricingDiagnostics> {
  const now = DateTime.toDateUtc(yield* DateTime.now)
  const { readRange } = overviewQueryRanges(input.scope, now)
  const snapshot = yield* loadLedgerQuerySnapshotEffect(input, readRange)
  const result = calculateSessionsView(snapshot, input.scope, now)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(result.unpricedModels)
  return yield* Schema.decodeUnknownEffect(Schema.mutable(Schema.Array(sessionRowSchema)))(result.rows)
})
