import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import { ledgerMcpCallsSchema, ledgerMcpScopeResultSchema } from '../../shared/schemas/ledger-mcp-results.js'
import type { OverviewScope } from '../../shared/schemas/overview.js'
import {
  calculateLedgerMcpCalls,
  calculateLedgerMcpScope,
  type LedgerMcpCallsInput,
} from '../ledger-mcp-calculation.js'
import { overviewDateRange } from '../overview-scope.js'
import type { PricingCatalogue } from '../pipeline/pricing-calculation.js'
import type { ProxyPathConfig } from '../pipeline/proxy-paths.js'
import { queryScopeFromSnapshotResult } from '../store/aggregate-calculation.js'
import type { LedgerQueries } from '../store/ledger-ports.js'
import { loadLedgerQuerySnapshotEffect } from '../store/ledger-query-snapshot.js'
import { PricingDiagnostics } from './pricing-diagnostics.js'

export type LedgerMcpSnapshotInputs = {
  readonly catalogue: PricingCatalogue
  readonly proxyPaths: ProxyPathConfig
}

export type LedgerMcpScopeQueryInputs = LedgerMcpSnapshotInputs & { readonly scope: OverviewScope }
export type LedgerMcpCallsQueryInputs = LedgerMcpSnapshotInputs & LedgerMcpCallsInput

export const queryLedgerMcpScope = Effect.fn('queryLedgerMcpScope')(function* (
  input: LedgerMcpScopeQueryInputs,
): Effect.fn.Return<
  Schema.Schema.Type<typeof ledgerMcpScopeResultSchema>,
  SqlError | Schema.SchemaError,
  LedgerQueries | PricingDiagnostics
> {
  const now = DateTime.toDateUtc(yield* DateTime.now)
  const snapshot = yield* loadLedgerQuerySnapshotEffect(input)
  const range = overviewDateRange(input.scope, now)
  const scoped = queryScopeFromSnapshotResult(snapshot, { range, provider: input.scope.provider })
  const result = calculateLedgerMcpScope(scoped.scope, input.scope, range)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(scoped.unpricedModels)
  return yield* Schema.decodeUnknownEffect(ledgerMcpScopeResultSchema)(result)
})

export const queryLedgerMcpCalls = Effect.fn('queryLedgerMcpCalls')(function* (
  input: LedgerMcpCallsQueryInputs,
): Effect.fn.Return<
  Schema.Schema.Type<typeof ledgerMcpCallsSchema>,
  SqlError | Schema.SchemaError,
  LedgerQueries | PricingDiagnostics
> {
  const now = DateTime.toDateUtc(yield* DateTime.now)
  const snapshot = yield* loadLedgerQuerySnapshotEffect(input)
  const range = overviewDateRange(input.scope, now)
  const scoped = queryScopeFromSnapshotResult(snapshot, { range, provider: input.scope.provider })
  const result = calculateLedgerMcpCalls(scoped.scope, input, range)
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(scoped.unpricedModels)
  return yield* Schema.decodeUnknownEffect(ledgerMcpCallsSchema)(result)
})
