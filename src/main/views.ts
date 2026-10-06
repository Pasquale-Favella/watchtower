import * as Schema from 'effect/Schema'

import {
  type AnalyticalViews,
  analyticalViewsSchema,
  type DashboardViews,
  dashboardViewsSchema,
} from '../shared/schemas/views.js'
import { reportUnpricedModels } from './pipeline/pricing-diagnostics.js'
import type { ProjectSummary } from './pipeline/types.js'
import { buildSessionSummaries, groupSummariesIntoProjects } from './store/aggregate.js'
import type { LedgerStore } from './store/ledger.js'
import { type LedgerQuerySnapshot, loadLedgerQuerySnapshot } from './store/query-snapshot.js'
import {
  buildAnalyticalViewsFromSnapshotResult as calculateAnalyticalViewsFromSnapshot,
  buildDashboardViewsFromSnapshotResult as calculateDashboardViewsFromSnapshot,
} from './views-calculation.js'

export type {
  AnalyticalViews,
  DashboardViews,
  ProjectRow,
  SearchHit,
  SessionDetail,
  SessionRow,
  SkillRow,
  SubagentRow,
} from '../shared/schemas/views.js'

/** All-time window: the ledger equivalent of reading a full report (no scope). */
const ALL_TIME_RANGE = { start: new Date(-8640000000000000), end: new Date(8640000000000000) } as const

export function buildAnalyticalViewsFromLedger(store: LedgerStore): AnalyticalViews {
  return Schema.decodeUnknownSync(analyticalViewsSchema)(
    buildAnalyticalViewsFromSnapshot(loadLedgerQuerySnapshot(store)),
  )
}

export function buildAnalyticalViewsFromSnapshot(snapshot: LedgerQuerySnapshot): AnalyticalViews {
  const result = calculateAnalyticalViewsFromSnapshot(snapshot)
  reportUnpricedModels(result.unpricedModels)
  return result.value
}

/**
 * The full ledger reassembled into `ProjectSummary[]` — the export path's
 * input (ADR 0013). No date filter: exports cover full history. Grouped
 * through the same helper the Optimize/Yield detector cores use, so project
 * shells stay consistent across every ledger consumer.
 */
export function buildProjectsFromLedger(store: LedgerStore): ProjectSummary[] {
  return groupSummariesIntoProjects(buildSessionSummaries(store, { range: ALL_TIME_RANGE }))
}

/**
 * Computes the Dashboard's view payload from the ledger (all-time scope). Kept
 * in the main process so the sandboxed renderer only receives serializable,
 * already-shaped rows over IPC and never touches the filesystem or the pipeline.
 */
export function buildDashboardViewsFromLedger(store: LedgerStore): DashboardViews {
  return Schema.decodeUnknownSync(dashboardViewsSchema)(buildDashboardViewsFromSnapshot(loadLedgerQuerySnapshot(store)))
}

export function buildDashboardViewsFromSnapshot(snapshot: LedgerQuerySnapshot): DashboardViews {
  const result = calculateDashboardViewsFromSnapshot(snapshot)
  reportUnpricedModels(result.unpricedModels)
  return result.value
}
