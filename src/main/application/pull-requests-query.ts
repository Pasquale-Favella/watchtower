import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import { type PullRequestsPayload, pullRequestsPayloadSchema } from '../../shared/schemas/pull-requests.js'
import { overviewDateRange } from '../overview-scope.js'
import { calculatePullRequestsPayload } from '../pull-requests-calculation.js'
import { buildSessionSummariesFromSnapshotResult } from '../store/aggregate-calculation.js'
import type { LedgerQueries } from '../store/ledger-ports.js'
import { loadLedgerQuerySnapshotEffect } from '../store/ledger-query-snapshot.js'
import { PricingDiagnostics } from './pricing-diagnostics.js'
import type { ScopedViewQueryInputs } from './view-queries.js'

export const queryPullRequestsView = Effect.fn('queryPullRequestsView')(function* (
  input: ScopedViewQueryInputs,
): Effect.fn.Return<PullRequestsPayload, SqlError | Schema.SchemaError, LedgerQueries | PricingDiagnostics> {
  const now = DateTime.toDateUtc(yield* DateTime.now)
  const snapshot = yield* loadLedgerQuerySnapshotEffect(input)
  const calculation = buildSessionSummariesFromSnapshotResult(snapshot, {
    range: overviewDateRange(input.scope, now),
    provider: input.scope.provider,
  })
  const payload = calculatePullRequestsPayload(calculation.summaries, snapshot.catalogue)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(calculation.unpricedModels)
  return yield* Schema.decodeUnknownEffect(pullRequestsPayloadSchema)(payload)
})
