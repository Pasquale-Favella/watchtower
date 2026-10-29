import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/sql/SqlError'

import { type OptimizePayload, optimizePayloadSchema } from '@/shared/schemas/optimize.js'
import { calculateOptimizePayload } from '@/core/analytics/detectors/optimize-calculation.js'
import { overviewQueryRanges } from '@/core/domain/sessions/overview-scope.js'
import {
  buildSessionSummariesFromSnapshotResult,
  groupSummariesIntoProjects,
} from '@/core/analytics/projections/aggregate-calculation.js'
import type { LedgerQueries } from '@/core/ports/repository.js'
import { loadLedgerQuerySnapshotEffect } from '@/core/application/queries/ledger-query-snapshot.js'
import { AssistantSetup } from '@/core/ports/assistant-setup.js'
import { PricingDiagnostics } from '@/core/ports/pricing-diagnostics.js'
import type { ScopedViewQueryInputs } from '@/core/application/queries/view-queries.js'

export type OptimizeQueryInputs = ScopedViewQueryInputs & { readonly homeDir?: string }

function diagnosticKey(row: { sourceId: number; sessionId: string; turnIndex: number; callIndex: number }): string {
  return `${row.sourceId}:${row.sessionId}:${row.turnIndex}:${row.callIndex}`
}

export const queryOptimizeView = Effect.fn('queryOptimizeView')(function* (
  input: OptimizeQueryInputs,
): Effect.fn.Return<
  OptimizePayload,
  SqlError | Schema.SchemaError,
  LedgerQueries | PricingDiagnostics | AssistantSetup
> {
  const now = DateTime.toDateUtc(yield* DateTime.now)
  const { range, readRange } = overviewQueryRanges(input.scope, now)
  const snapshot = yield* loadLedgerQuerySnapshotEffect(input, readRange, true)
  const callDiagnostics = new Map(snapshot.callDiagnostics?.map(row => [diagnosticKey(row), row]))
  const enrichedSnapshot = {
    ...snapshot,
    calls: snapshot.calls.map(call => ({ ...call, ...callDiagnostics.get(diagnosticKey(call)) })),
  }
  const result = buildSessionSummariesFromSnapshotResult(enrichedSnapshot, {
    range,
    provider: input.scope.provider,
  })
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(result.unpricedModels)
  const projects = groupSummariesIntoProjects(result.summaries)
  const setup =
    projects.length === 0 ||
    (input.scope.provider !== undefined && input.scope.provider !== 'claude') ||
    !result.summaries.some(s => s.turns.some(t => t.assistantCalls.some(c => c.provider === 'claude')))
      ? {
          home: input.homeDir ?? '',
          mcpConfigs: new Map(),
          envSettings: new Map(),
          agents: [],
          skills: [],
          commands: [],
        }
      : yield* (yield* AssistantSetup).getOptimizeSetup(
          [...new Set(projects.map(project => project.projectPath || project.project))],
          input.homeDir,
        )
  return yield* Schema.decodeUnknownEffect(optimizePayloadSchema)(
    calculateOptimizePayload(projects, input.scope, setup, now),
  )
})
