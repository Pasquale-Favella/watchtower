import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'

import type { OverviewScope } from '../shared/schemas/overview.js'
import { type YieldPayload, yieldPayloadSchema } from '../shared/schemas/yield.js'
import { CommandRunner } from './agents/command-runner.js'
import { inspectYieldProjects } from './application/repository-inspection.js'
import { overviewDateRange, scopeDateRange } from './overview-scope.js'
import type { ProjectSummary } from './pipeline/types.js'
import { RepositoryInspectionLive } from './repository-inspection-live.js'
import { buildSessionSummaries, groupSummariesIntoProjects } from './store/aggregate.js'
import type { LedgerStore } from './store/ledger.js'
import { calculateYieldPayload } from './yield-calculation.js'

export type { YieldBucket, YieldCategory, YieldDetail, YieldPayload } from '../shared/schemas/yield.js'

// Legacy removal condition: delete this bridge and both exported builders once
// the last caller migrates to the Effect-native query.
const legacyInspectionLayer = Layer.provide(RepositoryInspectionLive, CommandRunner.layer)

/** Legacy Promise adapter retained for existing Optimize callers. */
export async function buildYieldPayload(
  projects: ProjectSummary[],
  scope: OverviewScope,
  opts: { now?: Date } = {},
): Promise<YieldPayload> {
  const now = opts.now ?? new Date()
  const range = scopeDateRange(scope, now) ?? { start: new Date(0), end: now }
  const groups = await Effect.runPromise(
    inspectYieldProjects(projects, range).pipe(Effect.provide(legacyInspectionLayer)),
  )
  return Schema.decodeUnknownSync(yieldPayloadSchema)(calculateYieldPayload(groups, range))
}

/** Legacy ledger adapter; the application query owns the canonical snapshot path. */
export async function buildYieldViewFromLedger(
  store: LedgerStore,
  scope: OverviewScope,
  opts: { now?: Date } = {},
): Promise<YieldPayload> {
  const now = opts.now ?? new Date()
  const summaries = buildSessionSummaries(store, {
    range: overviewDateRange(scope, now),
    provider: scope.provider,
  })
  return buildYieldPayload(groupSummariesIntoProjects(summaries), scope, { now })
}
