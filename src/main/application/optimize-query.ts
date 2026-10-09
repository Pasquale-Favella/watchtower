import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import { type OptimizePayload, optimizePayloadSchema } from '../../shared/schemas/optimize.js'
import { calculateOptimizePayload } from '../optimize-calculation.js'
import { overviewDateRange } from '../overview-scope.js'
import { buildSessionSummariesFromSnapshotResult, groupSummariesIntoProjects } from '../store/aggregate-calculation.js'
import type { LedgerQueries } from '../store/ledger-ports.js'
import { loadLedgerQuerySnapshotEffect } from '../store/ledger-query-snapshot.js'
import { AssistantSetup } from './assistant-setup.js'
import { PricingDiagnostics } from './pricing-diagnostics.js'
import type { ScopedViewQueryInputs } from './view-queries.js'

export type OptimizeQueryInputs = ScopedViewQueryInputs & { readonly homeDir?: string }

export const queryOptimizeView = Effect.fn('queryOptimizeView')(function* (
  input: OptimizeQueryInputs,
): Effect.fn.Return<
  OptimizePayload,
  SqlError | Schema.SchemaError,
  LedgerQueries | PricingDiagnostics | AssistantSetup
> {
  const now = DateTime.toDateUtc(yield* DateTime.now)
  const snapshot = yield* loadLedgerQuerySnapshotEffect(input)
  const result = buildSessionSummariesFromSnapshotResult(snapshot, {
    range: overviewDateRange(input.scope, now),
    provider: input.scope.provider,
  })
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(result.unpricedModels)
  const projects = groupSummariesIntoProjects(result.summaries)
  const setup =
    projects.length === 0
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
