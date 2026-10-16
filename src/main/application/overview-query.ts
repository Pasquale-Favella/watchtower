import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import { type OverviewPayload, overviewPayloadSchema } from '../../shared/schemas/overview.js'
import { calculateOverviewFromData } from '../overview-calculation.js'
import type { LocalModelSavings } from '../pipeline/pricing-calculation.js'
import { LedgerViewReads } from '../store/ledger-view-reads.js'
import { PricingDiagnostics } from './pricing-diagnostics.js'
import type { ScopedViewQueryInputs } from './view-queries.js'

export type OverviewQueryInputs = ScopedViewQueryInputs & { readonly localSavings: LocalModelSavings }

export const queryOverview = Effect.fn('queryOverview')(function* (
  input: OverviewQueryInputs,
): Effect.fn.Return<OverviewPayload, SqlError | Schema.SchemaError, LedgerViewReads | PricingDiagnostics> {
  const now = DateTime.toDateUtc(yield* DateTime.now)
  const reads = yield* LedgerViewReads
  const data = yield* reads.getOverviewData()
  const result = calculateOverviewFromData(data, input.scope, now, input.catalogue, input.localSavings)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(result.unpricedModels)
  return yield* Schema.decodeUnknownEffect(overviewPayloadSchema)(result.value)
})
