import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import { type ProjectRow, projectRowSchema, type SessionRow, sessionRowSchema } from '../../shared/schemas/views.js'
import type { PricingCatalogue } from '../pipeline/pricing-calculation.js'
import { LedgerSessionReads } from '../store/ledger-session-reads.js'
import { buildProjectRowsFromSessionData, querySessionRowsFromSessionData } from '../store-rows-calculation.js'
import { PricingDiagnostics } from './pricing-diagnostics.js'

export const queryProjectRows = Effect.fn('queryProjectRows')(function* (input: {
  readonly catalogue: PricingCatalogue
}): Effect.fn.Return<ProjectRow[], SqlError | Schema.SchemaError, LedgerSessionReads | PricingDiagnostics> {
  const reads = yield* LedgerSessionReads
  const data = yield* reads.getSessionSummaryData()
  const result = buildProjectRowsFromSessionData(data, input.catalogue)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(result.unpricedModels)
  return yield* Schema.decodeUnknownEffect(Schema.mutable(Schema.Array(projectRowSchema)))(result.rows)
})

export const querySessionRows = Effect.fn('querySessionRows')(function* (input: {
  readonly catalogue: PricingCatalogue
  readonly filter: { project?: string; since?: string; until?: string }
}): Effect.fn.Return<SessionRow[], SqlError | Schema.SchemaError, LedgerSessionReads | PricingDiagnostics> {
  const reads = yield* LedgerSessionReads
  const data = yield* reads.getSessionSummaryData()
  const result = querySessionRowsFromSessionData(data, input.catalogue, input.filter)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(result.unpricedModels)
  return yield* Schema.decodeUnknownEffect(Schema.mutable(Schema.Array(sessionRowSchema)))(result.rows)
})
