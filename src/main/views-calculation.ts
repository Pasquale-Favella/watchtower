import type { AnalyticalViews, DashboardViews } from '../shared/schemas/views.js'
import { isProxiedPath } from './pipeline/proxy-paths.js'
import { sessionRowFromSummary } from './pipeline/session-row.js'
import type { SessionSummary, TaskCategory } from './pipeline/types.js'
import { CATEGORY_LABELS } from './pipeline/types.js'
import { buildSessionSummariesFromSnapshotResult, sessionProjectKey } from './store/aggregate-calculation.js'
import type { LedgerQuerySnapshot } from './store/ledger-query-snapshot.js'

const ALL_TIME_RANGE = { start: new Date(-8640000000000000), end: new Date(8640000000000000) } as const

export type ViewCalculationResult<T> = { value: T; unpricedModels: readonly string[] }

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

function buildDashboardCore(
  rows: ReturnType<typeof sessionRowFromSummary>[],
  sessions: SessionSummary[],
  kpis: DashboardViews['kpis'],
): DashboardViews {
  const costByDay = new Map<string, number>()
  const providerSum = new Map<string, Sum>()
  const modelSum = new Map<string, Sum>()
  const projectSum = new Map<string, Sum>()
  const categorySum = new Map<TaskCategory, Sum>()
  const projectKeyBySession = new Map(sessions.map(session => [session.sessionId, sessionProjectKey(session)]))
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
      .map(([name, sum]) => ({ name, cost: sum.cost, calls: sum.calls }))
      .sort(sortByCost) as unknown as T[]

  return {
    kpis,
    costOverTime: Array.from(costByDay.entries())
      .map(([date, cost]) => ({ date, cost }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    byProvider: toEntry<DashboardViews['byProvider'][number]>(providerSum).map(entry => ({
      ...entry,
      sessions: providerSum.get(entry.name)!.sessions,
    })),
    byModel: toEntry<DashboardViews['byModel'][number]>(modelSum),
    byProject: toEntry<DashboardViews['byProject'][number]>(projectSum).map(entry => ({
      ...entry,
      name: projectDisplayByKey.get(entry.name) ?? entry.name,
    })),
    byCategory: Array.from(categorySum.entries())
      .filter(([, sum]) => sum.cost !== 0 || sum.turns !== 0)
      .map(([category, sum]) => ({ name: CATEGORY_LABELS[category] ?? category, cost: sum.cost, turns: sum.turns }))
      .sort(sortByCost),
  }
}

function buildDashboardCoreFromSnapshot(snapshot: LedgerQuerySnapshot, summaries: SessionSummary[]): DashboardViews {
  const projectPathBySession = new Map<string, string>()
  for (const session of snapshot.sessions) {
    if (!projectPathBySession.has(session.sessionId))
      projectPathBySession.set(session.sessionId, session.projectPath ?? '')
  }
  const kpis: DashboardViews['kpis'] = {
    totalCost: 0,
    totalEstimatedCost: 0,
    totalSavings: 0,
    totalProxiedCost: 0,
    totalCalls: 0,
    totalSessions: summaries.length,
    totalProjects: new Set(summaries.map(session => sessionProjectKey(session))).size,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalReasoningTokens: 0,
  }
  for (const session of summaries) {
    kpis.totalCost += session.totalCostUSD
    kpis.totalEstimatedCost += session.totalEstimatedCostUSD ?? 0
    kpis.totalSavings += session.totalSavingsUSD
    if (isProxiedPath(projectPathBySession.get(session.sessionId), snapshot.proxyPaths))
      kpis.totalProxiedCost += session.totalCostUSD
    kpis.totalCalls += session.apiCalls
    kpis.totalInputTokens += session.totalInputTokens
    kpis.totalOutputTokens += session.totalOutputTokens
    kpis.totalCacheReadTokens += session.totalCacheReadTokens
    kpis.totalCacheWriteTokens += session.totalCacheWriteTokens
    kpis.totalReasoningTokens += session.totalReasoningTokens
  }
  return buildDashboardCore(
    summaries.map(session => sessionRowFromSummary(session, session.project)),
    summaries,
    kpis,
  )
}

function analyticalFrom(dashboard: DashboardViews, sessions: SessionSummary[]): AnalyticalViews {
  const skillSum = new Map<string, { turns: number; cost: number; savingsUSD: number }>()
  const subagentSum = new Map<string, { calls: number; cost: number; savingsUSD: number }>()
  for (const session of sessions) {
    for (const [name, value] of Object.entries(session.skillBreakdown)) {
      const sum = skillSum.get(name) ?? { turns: 0, cost: 0, savingsUSD: 0 }
      sum.turns += value.turns
      sum.cost += value.costUSD
      sum.savingsUSD += value.savingsUSD
      skillSum.set(name, sum)
    }
    for (const [name, value] of Object.entries(session.subagentBreakdown)) {
      const sum = subagentSum.get(name) ?? { calls: 0, cost: 0, savingsUSD: 0 }
      sum.calls += value.calls
      sum.cost += value.costUSD
      sum.savingsUSD += value.savingsUSD
      subagentSum.set(name, sum)
    }
  }
  const byCost = (a: { cost: number }, b: { cost: number }): number => b.cost - a.cost
  return {
    providers: dashboard.byProvider,
    models: dashboard.byModel,
    categories: dashboard.byCategory,
    skills: Array.from(skillSum.entries())
      .filter(([, sum]) => sum.cost !== 0 || sum.turns !== 0)
      .map(([name, sum]) => ({ name, turns: sum.turns, cost: sum.cost, savingsUSD: sum.savingsUSD }))
      .sort(byCost),
    subagents: Array.from(subagentSum.entries())
      .filter(([, sum]) => sum.cost !== 0 || sum.calls !== 0)
      .map(([name, sum]) => ({ name, calls: sum.calls, cost: sum.cost, savingsUSD: sum.savingsUSD }))
      .sort(byCost),
  }
}

export function buildDashboardViewsFromSnapshotResult(
  snapshot: LedgerQuerySnapshot,
): ViewCalculationResult<DashboardViews> {
  const calculation = buildSessionSummariesFromSnapshotResult(snapshot, { range: ALL_TIME_RANGE })
  return {
    value: buildDashboardCoreFromSnapshot(snapshot, calculation.summaries),
    unpricedModels: calculation.unpricedModels,
  }
}

export function buildDashboardViewsFromSnapshot(snapshot: LedgerQuerySnapshot): DashboardViews {
  return buildDashboardViewsFromSnapshotResult(snapshot).value
}

export function buildAnalyticalViewsFromSnapshotResult(
  snapshot: LedgerQuerySnapshot,
): ViewCalculationResult<AnalyticalViews> {
  const calculation = buildSessionSummariesFromSnapshotResult(snapshot, { range: ALL_TIME_RANGE })
  const dashboard = buildDashboardCoreFromSnapshot(snapshot, calculation.summaries)
  return {
    value: analyticalFrom(dashboard, calculation.summaries),
    unpricedModels: calculation.unpricedModels,
  }
}

export function buildAnalyticalViewsFromSnapshot(snapshot: LedgerQuerySnapshot): AnalyticalViews {
  return buildAnalyticalViewsFromSnapshotResult(snapshot).value
}
