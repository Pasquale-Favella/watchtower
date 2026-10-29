import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/sql/SqlError'

import { type PullRequestsPayload, pullRequestsPayloadSchema } from '@/shared/schemas/pull-requests.js'
import { overviewQueryRanges } from '@/core/domain/sessions/overview-scope.js'
import { calculatePullRequestsPayload } from '@/core/analytics/projections/pull-requests-calculation.js'
import { buildSessionSummariesFromSnapshotResult } from '@/core/analytics/projections/aggregate-calculation.js'
import type { LedgerQueries } from '@/core/ports/repository.js'
import { loadLedgerQuerySnapshotEffect } from '@/core/application/queries/ledger-query-snapshot.js'
import { PricingDiagnostics } from '@/core/ports/pricing-diagnostics.js'
import type { ScopedViewQueryInputs } from '@/core/application/queries/view-queries.js'

export const queryPullRequestsView = Effect.fn('queryPullRequestsView')(function* (
  input: ScopedViewQueryInputs,
): Effect.fn.Return<PullRequestsPayload, SqlError | Schema.SchemaError, LedgerQueries | PricingDiagnostics> {
  const now = DateTime.toDateUtc(yield* DateTime.now)
  const { range, readRange } = overviewQueryRanges(input.scope, now)
  const snapshot = yield* loadLedgerQuerySnapshotEffect(input, readRange)
  const calculation = buildSessionSummariesFromSnapshotResult(snapshot, {
    range,
    provider: input.scope.provider,
  })
  const payload = calculatePullRequestsPayload(calculation.summaries, snapshot.catalogue)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(calculation.unpricedModels)
  return yield* Schema.decodeUnknownEffect(pullRequestsPayloadSchema)(payload)
})
