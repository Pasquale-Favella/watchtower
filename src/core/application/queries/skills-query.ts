import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/sql/SqlError'

import {
  DEFAULT_SKILLS_THRESHOLDS,
  type SkillsPayload,
  skillsPayloadSchema,
  type SkillsThresholds,
} from '@/shared/schemas/skills.js'
import { overviewQueryRanges } from '@/core/domain/sessions/overview-scope.js'
import { calculateSkillsView } from '@/core/analytics/detectors/skills-calculation.js'
import { buildSessionSummariesFromSnapshotResult } from '@/core/analytics/projections/aggregate-calculation.js'
import type { LedgerQueries } from '@/core/ports/repository.js'
import { LedgerConfig } from '@/core/ports/repository.js'
import { loadLedgerQuerySnapshotEffect } from '@/core/application/queries/ledger-query-snapshot.js'
import { AssistantSetup } from '@/core/ports/assistant-setup.js'
import { PricingDiagnostics } from '@/core/ports/pricing-diagnostics.js'
import type { ScopedViewQueryInputs } from '@/core/application/queries/view-queries.js'

export type SkillsViewQueryInputs = ScopedViewQueryInputs & {
  readonly thresholds?: SkillsThresholds
  readonly homeDir?: string
}

export const querySkillsView = Effect.fn('querySkillsView')(function* (
  input: SkillsViewQueryInputs,
): Effect.fn.Return<
  SkillsPayload,
  SqlError | Schema.SchemaError,
  LedgerQueries | LedgerConfig | AssistantSetup | PricingDiagnostics
> {
  const now = DateTime.toDateUtc(yield* DateTime.now)
  const { range: dateRange, readRange } = overviewQueryRanges(input.scope, now)
  const snapshot = yield* loadLedgerQuerySnapshotEffect(input, readRange)
  const aggregation = buildSessionSummariesFromSnapshotResult(snapshot, {
    range: dateRange,
    provider: input.scope.provider,
  })
  const config = yield* LedgerConfig
  const dismissals = yield* config.getSkillDismissals()
  const setup = yield* AssistantSetup
  const workingDirectories = [
    ...new Set(aggregation.summaries.flatMap(summary => (summary.workingDirectory ? [summary.workingDirectory] : []))),
  ]
  const inventory = yield* setup.getSkillInventory(workingDirectories, input.homeDir)
  const payload = calculateSkillsView(
    aggregation.summaries,
    inventory,
    dateRange,
    input.thresholds ?? DEFAULT_SKILLS_THRESHOLDS,
    dismissals,
  )
  const diagnostics = yield* PricingDiagnostics
  yield* diagnostics.reportUnpricedModels(aggregation.unpricedModels)
  return yield* Schema.decodeUnknownEffect(skillsPayloadSchema)(payload)
})
