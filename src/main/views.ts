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
  type SkillRow,
  type SubagentRow,
} from '../shared/schemas/views.js'
import { isProxiedPath } from './pipeline/models.js'
import { type SessionRow as ReportSessionRow, sessionRowFromSummary } from './pipeline/sessions-report.js'
import type { ProjectSummary, SessionSummary, TaskCategory } from './pipeline/types.js'
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

/**
 * The four analytical screens from ledger rows. Only providers/models that
 * actually appear in the data are listed — detected-only rendering, so absent
 * providers never render a placeholder.
 */
function analyticalFrom(dashboard: DashboardViews, sessions: SessionSummary[]): AnalyticalViews {
  const skillSum = new Map<string, { turns: number; cost: number; savingsUSD: number }>()
  const subagentSum = new Map<string, { calls: number; cost: number; savingsUSD: number }>()
  for (const session of sessions) {
    for (const [name, v] of Object.entries(session.skillBreakdown)) {
      const sum = skillSum.get(name) ?? { turns: 0, cost: 0, savingsUSD: 0 }
      sum.turns += v.turns
      sum.cost += v.costUSD
      sum.savingsUSD += v.savingsUSD
      skillSum.set(name, sum)
    }
    for (const [name, v] of Object.entries(session.subagentBreakdown)) {
      const sum = subagentSum.get(name) ?? { calls: 0, cost: 0, savingsUSD: 0 }
      sum.calls += v.calls
      sum.cost += v.costUSD
      sum.savingsUSD += v.savingsUSD
      subagentSum.set(name, sum)
    }
  }

  const byCost = (a: { cost: number }, b: { cost: number }): number => b.cost - a.cost
  return {
    providers: dashboard.byProvider,
    models: dashboard.byModel,
    categories: dashboard.byCategory,
    skills: Array.from(skillSum.entries())
      .filter(([, s]) => s.cost !== 0 || s.turns !== 0)
      .map(([name, s]) => ({ name, turns: s.turns, cost: s.cost, savingsUSD: s.savingsUSD }))
      .sort(byCost),
    subagents: Array.from(subagentSum.entries())
      .filter(([, s]) => s.cost !== 0 || s.calls !== 0)
      .map(([name, s]) => ({ name, calls: s.calls, cost: s.cost, savingsUSD: s.savingsUSD }))
      .sort(byCost),
  }
}

export function buildAnalyticalViewsFromLedger(store: LedgerStore): AnalyticalViews {
  return Schema.decodeUnknownSync(analyticalViewsSchema)(
    buildAnalyticalViewsFromSnapshot(loadLedgerQuerySnapshot(store)),
  )
}

export function buildAnalyticalViewsFromSnapshot(snapshot: LedgerQuerySnapshot): AnalyticalViews {
  const summaries = buildSessionSummariesFromSnapshot(snapshot, { range: ALL_TIME_RANGE })
  const dashboard = buildDashboardCoreFromSummaries(summaries, snapshot.sessions)
  return analyticalFrom(dashboard, summaries)
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

type Sum = { cost: number; calls: number; sessions: number; turns: number }

function emptySum(): Sum {
  return { cost: 0, calls: 0, sessions: 0, turns: 0 }
}

function addSum(target: Sum, cost: number, calls: number, turns: number): void {
  target.cost += cost
  target.calls += calls
  target.turns += turns
  target.sessions += 1
}

/**
 * Dashboard payload core: `rows` and `sessions` must be the same sessions (rows
 * are shaped from the summaries) so the derived buckets are consistent.
 */
function buildDashboardCore(
  rows: ReportSessionRow[],
  sessions: SessionSummary[],
  kpis: DashboardViews['kpis'],
): DashboardViews {
  const costByDay = new Map<string, number>()
  const providerSum = new Map<string, Sum>()
  const modelSum = new Map<string, Sum>()
  const projectSum = new Map<string, Sum>()
  const categorySum = new Map<TaskCategory, Sum>()
  // Same-leaf checkouts share a display leaf but never a canonical key: group
  // the project bucket by key and keep the leaf only for display.
  const projectKeyBySession = new Map(sessions.map(s => [s.sessionId, sessionProjectKey(s)]))
  const projectDisplayByKey = new Map<string, string>()

  for (const row of rows) {
    const day = row.startedAt.slice(0, 10)
    costByDay.set(day, (costByDay.get(day) ?? 0) + row.cost)

    const provider = providerSum.get(row.provider) ?? emptySum()
    addSum(provider, row.cost, row.calls, row.turns)
    providerSum.set(row.provider, provider)

    for (const model of row.models) {
      const modelEntry = modelSum.get(model) ?? emptySum()
      addSum(modelEntry, row.cost, row.calls, row.turns)
      modelSum.set(model, modelEntry)
    }

    const projectKey = projectKeyBySession.get(row.sessionId) ?? row.project
    if (!projectDisplayByKey.has(projectKey)) projectDisplayByKey.set(projectKey, row.project)
    const project = projectSum.get(projectKey) ?? emptySum()
    addSum(project, row.cost, row.calls, row.turns)
    projectSum.set(projectKey, project)
  }

  for (const session of sessions) {
    for (const [category, value] of Object.entries(session.categoryBreakdown) as Array<
      [TaskCategory, { turns: number; costUSD: number }]
    >) {
      const sum = categorySum.get(category) ?? emptySum()
      sum.cost += value.costUSD
      sum.turns += value.turns
      categorySum.set(category, sum)
    }
  }

  const sortByCost = (a: { cost: number }, b: { cost: number }): number => b.cost - a.cost
  const toEntry = <T>(map: Map<string, Sum>): T[] =>
    Array.from(map.entries())
      .map(([name, s]) => ({ name, cost: s.cost, calls: s.calls }))
      .sort(sortByCost) as unknown as T[]

  return {
    kpis,
    costOverTime: Array.from(costByDay.entries())
      .map(([date, cost]) => ({ date, cost }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    byProvider: toEntry<DashboardViews['byProvider'][number]>(providerSum).map(e => ({
      ...e,
      sessions: providerSum.get(e.name)!.sessions,
    })),
    byModel: toEntry<DashboardViews['byModel'][number]>(modelSum),
    byProject: toEntry<DashboardViews['byProject'][number]>(projectSum).map(e => ({
      ...e,
      name: projectDisplayByKey.get(e.name) ?? e.name,
    })),
    byCategory: Array.from(categorySum.entries())
      .filter(([, s]) => s.cost !== 0 || s.turns !== 0)
      .map(([category, s]) => ({ name: CATEGORY_LABELS[category] ?? category, cost: s.cost, turns: s.turns }))
      .sort(sortByCost),
  }
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
  const summaries = buildSessionSummariesFromSnapshot(snapshot, { range: ALL_TIME_RANGE })
  return buildDashboardCoreFromSummaries(summaries, snapshot.sessions)
}

function buildDashboardCoreFromSummaries(
  summaries: SessionSummary[],
  ledgerSessions: ReturnType<typeof loadLedgerQuerySnapshot>['sessions'],
): DashboardViews {
  const projectPathBySession = new Map<string, string>()
  for (const s of ledgerSessions) {
    if (!projectPathBySession.has(s.sessionId)) projectPathBySession.set(s.sessionId, s.projectPath ?? '')
  }

  const kpis: DashboardViews['kpis'] = {
    totalCost: 0,
    totalEstimatedCost: 0,
    totalSavings: 0,
    totalProxiedCost: 0,
    totalCalls: 0,
    totalSessions: summaries.length,
    totalProjects: new Set(summaries.map(s => sessionProjectKey(s))).size,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalReasoningTokens: 0,
  }
  for (const s of summaries) {
    kpis.totalCost += s.totalCostUSD
    kpis.totalEstimatedCost += s.totalEstimatedCostUSD ?? 0
    kpis.totalSavings += s.totalSavingsUSD
    if (isProxiedPath(projectPathBySession.get(s.sessionId))) kpis.totalProxiedCost += s.totalCostUSD
    kpis.totalCalls += s.apiCalls
    kpis.totalInputTokens += s.totalInputTokens
    kpis.totalOutputTokens += s.totalOutputTokens
    kpis.totalCacheReadTokens += s.totalCacheReadTokens
    kpis.totalCacheWriteTokens += s.totalCacheWriteTokens
    kpis.totalReasoningTokens += s.totalReasoningTokens
  }

  const rows = summaries.map(s => sessionRowFromSummary(s, s.project))
  return buildDashboardCore(rows, summaries, kpis)
}
