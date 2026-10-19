import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/sql/SqlError'

import { type SessionRow, sessionRowSchema } from '../../shared/schemas/views.js'
import { overviewDateRange } from '../overview-scope.js'
import { calculateSessionsView } from '../sessions-calculation.js'
import type { LedgerQueries } from '../store/ledger-ports.js'
import { loadLedgerQuerySnapshotEffect } from '../store/ledger-query-snapshot.js'
import { PricingDiagnostics } from './pricing-diagnostics.js'
import type { ScopedViewQueryInputs } from './view-queries.js'

export const querySessionsView = Effect.fn('querySessionsView')(function* (
  input: ScopedViewQueryInputs,
): Effect.fn.Return<SessionRow[], SqlError | Schema.SchemaError, LedgerQueries | PricingDiagnostics> {
  const now = DateTime.toDateUtc(yield* DateTime.now)
  const range = overviewDateRange(input.scope, now)
  const readRange = input.scope.period === 'lifetime' && !input.scope.range ? undefined : range
  const snapshot = yield* loadLedgerQuerySnapshotEffect(input, readRange)
  const result = calculateSessionsView(snapshot, input.scope, now)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(result.unpricedModels)
  return yield* Schema.decodeUnknownEffect(Schema.mutable(Schema.Array(sessionRowSchema)))(result.rows)
})
