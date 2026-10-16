import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import { type SessionDetail, sessionDetailSchema } from '../../shared/schemas/views.js'
import type { PricingCatalogue } from '../pipeline/pricing-calculation.js'
import type { ProxyPathConfig } from '../pipeline/proxy-paths.js'
import { calculateSessionDetail } from '../session-detail-calculation.js'
import { buildSessionSummariesFromSnapshotResult } from '../store/aggregate-calculation.js'
import { makeLedgerQuerySnapshot } from '../store/ledger-query-snapshot.js'
import { LedgerSessionReads } from '../store/ledger-session-reads.js'
import { PricingDiagnostics } from './pricing-diagnostics.js'

/** Fetch full detail facts for the requested public ID, retaining source identity. */
export const querySessionDetail = Effect.fn('querySessionDetail')(function* (input: {
  readonly catalogue: PricingCatalogue
  readonly proxyPaths: ProxyPathConfig
  readonly sessionId: string
}): Effect.fn.Return<SessionDetail | null, SqlError | Schema.SchemaError, LedgerSessionReads | PricingDiagnostics> {
  const reads = yield* LedgerSessionReads
  const data = yield* reads.getSessionDetailData(input.sessionId)
  const snapshot = makeLedgerQuerySnapshot({ ...data, catalogue: input.catalogue, proxyPaths: input.proxyPaths })
  const result = buildSessionSummariesFromSnapshotResult(snapshot, {
    range: { start: new Date(-8640000000000000), end: new Date(8640000000000000) },
  })
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(result.unpricedModels)
  const session = result.summaries.find(summary => summary.sessionId === input.sessionId)
  if (!session) return null
  return yield* Schema.decodeUnknownEffect(sessionDetailSchema)(calculateSessionDetail(session))
})
