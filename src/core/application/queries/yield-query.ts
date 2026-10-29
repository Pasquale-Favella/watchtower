import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/sql/SqlError'

import { type YieldPayload, yieldPayloadSchema } from '@/shared/schemas/yield.js'
import { overviewQueryRanges, scopeDateRange } from '@/core/domain/sessions/overview-scope.js'
import {
  buildSessionSummariesFromSnapshotResult,
  groupSummariesIntoProjects,
} from '@/core/analytics/projections/aggregate-calculation.js'
import type { LedgerQueries } from '@/core/ports/repository.js'
import { loadLedgerQuerySnapshotEffect } from '@/core/application/queries/ledger-query-snapshot.js'
import { calculateYieldPayload } from '@/core/analytics/attribution/yield-calculation.js'
import { PricingDiagnostics } from '@/core/ports/pricing-diagnostics.js'
import { inspectYieldProjects, type RepositoryInspection } from '@/core/ports/repository-inspection.js'
import type { ScopedViewQueryInputs } from '@/core/application/queries/view-queries.js'

export const queryYieldView = Effect.fn('queryYieldView')(function* (
  input: ScopedViewQueryInputs,
): Effect.fn.Return<
  YieldPayload,
  SqlError | Schema.SchemaError,
  LedgerQueries | PricingDiagnostics | RepositoryInspection
> {
  const now = DateTime.toDateUtc(yield* DateTime.now)
  const { range, readRange } = overviewQueryRanges(input.scope, now)
  const snapshot = yield* loadLedgerQuerySnapshotEffect(input, readRange)
  const calculation = buildSessionSummariesFromSnapshotResult(snapshot, {
    range,
    provider: input.scope.provider,
  })
  const detectorRange = scopeDateRange(input.scope, now) ?? { start: new Date(0), end: now }
  const evidenceRange = {
    start: detectorRange.start,
    end: new Date(Math.min(detectorRange.end.getTime() + 60 * 60 * 1000, now.getTime())),
    observedAt: now,
  }
  const groups = yield* inspectYieldProjects(groupSummariesIntoProjects(calculation.summaries), evidenceRange)
  const payload = calculateYieldPayload(groups, detectorRange, now, evidenceRange)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(calculation.unpricedModels)
  return yield* Schema.decodeUnknownEffect(yieldPayloadSchema)(payload)
})
