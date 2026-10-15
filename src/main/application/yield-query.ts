import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import { type YieldPayload, yieldPayloadSchema } from '../../shared/schemas/yield.js'
import { overviewDateRange, scopeDateRange } from '../overview-scope.js'
import { buildSessionSummariesFromSnapshotResult, groupSummariesIntoProjects } from '../store/aggregate-calculation.js'
import type { LedgerQueries } from '../store/ledger-ports.js'
import { loadLedgerQuerySnapshotEffect } from '../store/ledger-query-snapshot.js'
import { calculateYieldPayload } from '../yield-calculation.js'
import { PricingDiagnostics } from './pricing-diagnostics.js'
import { inspectYieldProjects, type RepositoryInspection } from './repository-inspection.js'
import type { ScopedViewQueryInputs } from './view-queries.js'

export const queryYieldView = Effect.fn('queryYieldView')(function* (
  input: ScopedViewQueryInputs,
): Effect.fn.Return<
  YieldPayload,
  SqlError | Schema.SchemaError,
  LedgerQueries | PricingDiagnostics | RepositoryInspection
> {
  const now = DateTime.toDateUtc(yield* DateTime.now)
  const snapshot = yield* loadLedgerQuerySnapshotEffect(input)
  const calculation = buildSessionSummariesFromSnapshotResult(snapshot, {
    range: overviewDateRange(input.scope, now),
    provider: input.scope.provider,
  })
  const range = scopeDateRange(input.scope, now) ?? { start: new Date(0), end: now }
  const groups = yield* inspectYieldProjects(groupSummariesIntoProjects(calculation.summaries), range)
  const payload = calculateYieldPayload(groups, range)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(calculation.unpricedModels)
  return yield* Schema.decodeUnknownEffect(yieldPayloadSchema)(payload)
})
