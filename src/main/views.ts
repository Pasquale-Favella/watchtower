import * as Schema from 'effect/Schema'

import {
  type AnalyticalViews,
  analyticalViewsSchema,
  type DashboardViews,
  dashboardViewsSchema,
  type ProjectRow,
  projectRowSchema,
  type SearchHit,
  searchHitSchema,
  type SessionDetail,
  sessionDetailSchema,
  type SessionRow,
  sessionRowSchema,
} from '../shared/schemas/views.js'
import { reportUnpricedModels } from './pipeline/pricing-diagnostics.js'
import { sessionRowFromSummary } from './pipeline/sessions-report.js'
import type { ProjectSummary, SessionSummary } from './pipeline/types.js'
import { CATEGORY_LABELS } from './pipeline/types.js'
import {
  buildSessionRows,
  buildSessionSummaries,
  buildSessionSummariesFromSnapshot,
  groupSummariesIntoProjects,
  sessionProjectKey,
} from './store/aggregate.js'
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
 * Global search across session user messages and bash commands. Pure-text match
 * on the ledger; returns matching sessions so a hit can open its detail.
 */
export function searchSessionsFromLedger(store: LedgerStore, query: string): SearchHit[] {
  const term = query.trim().toLowerCase()
  if (!term) return []
  return Schema.decodeUnknownSync(Schema.mutable(Schema.Array(searchHitSchema)))(searchSessionsCore(store, term))
}

function searchSessionsCore(store: LedgerStore, term: string): SearchHit[] {
  const hits: SearchHit[] = []
  const seen = new Set<string>()
  const summaries = buildSessionSummaries(store, { range: ALL_TIME_RANGE })

  for (const session of summaries) {
    const provider = sessionRowFromSummary(session, session.project).provider
    const push = (kind: 'message' | 'bash', timestamp: string, snippet: string): void => {
      if (seen.has(session.sessionId) || hits.length >= 500) return
      seen.add(session.sessionId)
      hits.push({
        sessionId: session.sessionId,
        project: session.project,
        provider,
        timestamp,
        kind,
        snippet,
      })
    }
    for (const turn of session.turns) {
      if (turn.userMessage.toLowerCase().includes(term)) {
        push('message', turn.timestamp, turn.userMessage)
      }
      for (const call of turn.assistantCalls) {
        for (const cmd of call.bashCommands) {
          if (cmd.toLowerCase().includes(term)) {
            push('bash', call.timestamp, cmd)
          }
        }
      }
    }
  }
  return hits
}

/**
 * Computes the Projects list view: one row per project with its aggregated
 * cost, calls, session count, and time span.
 */
export function buildProjectRowsFromLedger(store: LedgerStore): ProjectRow[] {
  const snapshot = loadLedgerQuerySnapshot(store)
  return Schema.decodeUnknownSync(Schema.mutable(Schema.Array(projectRowSchema)))(buildProjectRowsCore(snapshot))
}

function buildProjectRowsCore(snapshot: ReturnType<typeof loadLedgerQuerySnapshot>): ProjectRow[] {
  const summaries = buildSessionSummariesFromSnapshot(snapshot, { range: ALL_TIME_RANGE })
  const projectPathBySession = new Map<string, string>()
  for (const s of snapshot.sessions) {
    if (!projectPathBySession.has(s.sessionId)) projectPathBySession.set(s.sessionId, s.projectPath ?? '')
  }
  const byProject = new Map<string, ProjectRow>()
  for (const s of summaries) {
    // Key on the canonical project key so same-leaf checkouts (/a/src,
    // /b/src) stay separate buckets; the row keeps the leaf only for display.
    const key = sessionProjectKey(s)
    let row = byProject.get(key)
    if (!row) {
      row = {
        project: s.project,
        projectPath: s.projectPath ?? projectPathBySession.get(s.sessionId) ?? '',
        cost: 0,
        calls: 0,
        sessions: 0,
        firstTimestamp: '',
        lastTimestamp: '',
      }
      byProject.set(key, row)
    }
    row.cost += s.totalCostUSD
    row.calls += s.apiCalls
    row.sessions += 1
    if (!row.firstTimestamp || s.firstTimestamp < row.firstTimestamp) row.firstTimestamp = s.firstTimestamp
    if (!row.lastTimestamp || s.lastTimestamp > row.lastTimestamp) row.lastTimestamp = s.lastTimestamp
    if (!row.repoUrl) row.repoUrl = s.repoUrl
  }
  return Array.from(byProject.values()).sort((a, b) => b.cost - a.cost)
}

/**
 * Filters sessions by project and/or date range. The range filter is applied at
 * query time against the ledger — no rescan.
 */
export function querySessionRowsFromLedger(
  store: LedgerStore,
  filter: { project?: string; since?: string; until?: string },
): SessionRow[] {
  const sinceMs = filter.since ? new Date(filter.since).getTime() : Number.NEGATIVE_INFINITY
  const untilMs = filter.until ? new Date(filter.until).getTime() : Number.POSITIVE_INFINITY
  const rows = buildSessionRows(store, { range: ALL_TIME_RANGE })
    .filter(row => {
      if (filter.project && row.project !== filter.project) return false
      const start = new Date(row.startedAt).getTime()
      if (Number.isFinite(start) && start < sinceMs) return false
      if (Number.isFinite(start) && start > untilMs) return false
      return true
    })
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
  return Schema.decodeUnknownSync(Schema.mutable(Schema.Array(sessionRowSchema)))(rows)
}

/**
 * The full session detail for the drill-down view: session-level totals plus a
 * per-turn timeline with each turn's assistant calls, assembled from the ledger.
 */
function sessionDetailFromSummary(session: SessionSummary): SessionDetail {
  const provider = sessionRowFromSummary(session, session.project).provider
  return {
    sessionId: session.sessionId,
    project: session.project,
    provider,
    title: session.title ?? '',
    workingDirectory: session.workingDirectory,
    firstTimestamp: session.firstTimestamp,
    lastTimestamp: session.lastTimestamp,
    totalCostUSD: session.totalCostUSD,
    totalEstimatedCostUSD: session.totalEstimatedCostUSD ?? 0,
    totalSavingsUSD: session.totalSavingsUSD,
    totalInputTokens: session.totalInputTokens,
    totalOutputTokens: session.totalOutputTokens,
    totalCacheReadTokens: session.totalCacheReadTokens,
    totalCacheWriteTokens: session.totalCacheWriteTokens,
    totalReasoningTokens: session.totalReasoningTokens,
    apiCalls: session.apiCalls,
    prLinks: session.prLinks ?? [],
    modelBreakdown: Object.fromEntries(
      Object.entries(session.modelBreakdown).map(([model, b]) => [model, { calls: b.calls, costUSD: b.costUSD }]),
    ),
    turns: session.turns.map(turn => ({
      timestamp: turn.timestamp,
      userMessage: turn.userMessage,
      category: CATEGORY_LABELS[turn.category] ?? turn.category,
      gitBranch: turn.gitBranch,
      prRefs: turn.prRefs ?? [],
      retries: turn.retries,
      hasEdits: turn.hasEdits,
      assistantCalls: turn.assistantCalls.map(call => ({
        provider: call.provider,
        model: call.model,
        costUSD: call.costUSD,
        isEstimated: call.isEstimated,
        savingsUSD: call.savingsUSD,
        speed: call.speed,
        hasPlanMode: call.hasPlanMode,
        tools: call.tools,
        mcpTools: call.mcpTools,
        skills: call.skills,
        subagentTypes: call.subagentTypes,
        usage: {
          inputTokens: call.usage.inputTokens,
          outputTokens: call.usage.outputTokens,
          reasoningTokens: call.usage.reasoningTokens,
          cacheReadInputTokens: call.usage.cacheReadInputTokens,
          cacheCreationInputTokens: call.usage.cacheCreationInputTokens,
        },
      })),
    })),
  }
}

export function getSessionDetailFromLedger(store: LedgerStore, sessionId: string): SessionDetail | null {
  const summaries = buildSessionSummaries(store, { range: ALL_TIME_RANGE })
  const session = summaries.find(s => s.sessionId === sessionId)
  return session ? Schema.decodeUnknownSync(sessionDetailSchema)(sessionDetailFromSummary(session)) : null
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
