import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import {
  DEFAULT_SKILLS_THRESHOLDS,
  type SkillsPayload,
  skillsPayloadSchema,
  type SkillsThresholds,
} from '../../shared/schemas/skills.js'
import { overviewDateRange } from '../overview-scope.js'
import { calculateSkillsView } from '../skills-calculation.js'
import { buildSessionSummariesFromSnapshotResult } from '../store/aggregate-calculation.js'
import type { LedgerQueries } from '../store/ledger-ports.js'
import { LedgerConfig } from '../store/ledger-ports.js'
import { loadLedgerQuerySnapshotEffect } from '../store/ledger-query-snapshot.js'
import { AssistantSetup } from './assistant-setup.js'
import { PricingDiagnostics } from './pricing-diagnostics.js'
import type { ScopedViewQueryInputs } from './view-queries.js'

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
  const snapshot = yield* loadLedgerQuerySnapshotEffect(input)
  const dateRange = overviewDateRange(input.scope, now)
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
