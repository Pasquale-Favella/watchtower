import type { AnalyticalViews, DashboardViews } from '../shared/schemas/views.js'
import { canonicalSessionProject } from './canonical-session-project.js'
import { getShortModelName } from './pipeline/model-names.js'
import {
  calculateRepricedCostResult,
  createPricingConfigLookup,
  type PricingCatalogue,
  resolveModelNameAlias,
} from './pipeline/pricing-calculation.js'
import { isProxiedPath, type ProxyPathConfig } from './pipeline/proxy-paths.js'
import { providerFromModel } from './pipeline/session-row.js'
import { CATEGORY_LABELS, type TaskCategory } from './pipeline/types.js'
import type { LedgerViewData } from './store/view-read-projections.js'

export type ViewCalculationInputs = {
  readonly catalogue: PricingCatalogue
  readonly proxyPaths: ProxyPathConfig
}

export type ViewCalculationResult<T> = {
  value: T
  unpricedModels: readonly string[]
}

type ViewCall = LedgerViewData['calls'][number]
type PricedCall = { row: ViewCall; resolvedModel: string; cost: number }
type AdmittedTurn = { row: LedgerViewData['turns'][number]; calls: PricedCall[]; firstMs: number }

type DashboardSessionMetrics = {
  projectKey: string
  project: string
  estimatedCost: number
  savings: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  startedAt: string
  endedAt: string
}

type AnalyticalSessionMetrics = {
  skills: Record<string, { cost: number; savings: number; turns: number }>
  subagents: Record<string, { cost: number; savings: number; calls: number }>
}

type SessionAggregate = {
  session: LedgerViewData['sessions'][number]
  models: string[]
  provider: string
  cost: number
  calls: number
  categories: Record<string, { cost: number; turns: number }>
  dashboard?: DashboardSessionMetrics
  analytical?: AnalyticalSessionMetrics
}

type Sum = { cost: number; calls: number; sessions: number }

const ALL_TIME_MIN = -8.64e15
const ALL_TIME_MAX = 8.64e15

function sessionKey(sourceId: number, sessionId: string): string {
  return `${sourceId}\0${sessionId}`
}

function turnKey(sourceId: number, sessionId: string, turnIndex: number): string {
  return `${sessionKey(sourceId, sessionId)}\0${turnIndex}`
}

function timestampMs(value: string): number {
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function emptySum(): Sum {
  return { cost: 0, calls: 0, sessions: 0 }
}

function addSession(sum: Sum, session: SessionAggregate): void {
  sum.cost += session.cost
  sum.calls += session.calls
  sum.sessions++
}

function addTurnCost(map: Map<string, { cost: number; turns: number }>, name: string, cost: number): void {
  const sum = map.get(name) ?? { cost: 0, turns: 0 }
  sum.cost += cost
  sum.turns++
  map.set(name, sum)
}

function calculateSessions(
  data: LedgerViewData,
  catalogue: PricingCatalogue,
  mode: 'dashboard' | 'analytical',
): { sessions: SessionAggregate[]; unpricedModels: readonly string[] } {
  const pricing = createPricingConfigLookup(data.aliases, data.overrides)
  const sessionsByKey = new Map<string, LedgerViewData['sessions'][number]>()
  for (const session of data.sessions) sessionsByKey.set(sessionKey(session.sourceId, session.sessionId), session)

  const callsByTurn = new Map<string, PricedCall[]>()
  const unpricedModels = new Set<string>()
  for (const call of data.calls) {
    const resolvedModel = pricing.resolveAlias(call.model)
    const result = calculateRepricedCostResult(catalogue, pricing, {
      model: call.model,
      effectiveModel: resolvedModel,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cacheWriteTokens: call.cacheCreationInputTokens,
      cacheReadTokens: Math.max(call.cacheReadInputTokens, call.cachedInputTokens),
      webSearchRequests: call.webSearchRequests,
      speed: call.speed,
      recordedCost: call.baseCostUSD,
    })
    if (!result.priced) unpricedModels.add(resolvedModel)
    const key = turnKey(call.sourceId, call.sessionId, call.turnIndex)
    const calls = callsByTurn.get(key) ?? []
    calls.push({ row: call, resolvedModel, cost: result.cost })
    callsByTurn.set(key, calls)
  }

  const turnsBySession = new Map<string, AdmittedTurn[]>()
  for (const turn of data.turns) {
    const calls = (callsByTurn.get(turnKey(turn.sourceId, turn.sessionId, turn.turnIndex)) ?? []).sort(
      (a, b) => a.row.callIndex - b.row.callIndex,
    )
    const firstCall = calls[0]
    if (!firstCall) continue
    const firstMs = timestampMs(firstCall.row.timestamp)
    if (!Number.isFinite(firstMs) || firstMs < ALL_TIME_MIN || firstMs > ALL_TIME_MAX) continue
    const key = sessionKey(turn.sourceId, turn.sessionId)
    const turns = turnsBySession.get(key) ?? []
    turns.push({ row: turn, calls, firstMs })
    turnsBySession.set(key, turns)
  }

  const sessions: SessionAggregate[] = []
  for (const [key, turns] of turnsBySession) {
    const session = sessionsByKey.get(key)
    if (!session) continue
    turns.sort((a, b) => a.firstMs - b.firstMs || a.row.timestamp.localeCompare(b.row.timestamp))
    const models: Record<string, true> = {}
    const categories = new Map<string, { cost: number; turns: number }>()
    const skills =
      mode === 'analytical' ? new Map<string, { cost: number; savings: number; turns: number }>() : undefined
    const subagents =
      mode === 'analytical' ? new Map<string, { cost: number; savings: number; calls: number }>() : undefined
    const totals = { cost: 0, calls: 0 }
    const dashboardTotals =
      mode === 'dashboard'
        ? {
            estimatedCost: 0,
            savings: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            startedAt: '',
            endedAt: '',
          }
        : undefined

    for (const turn of turns) {
      const turnCost = turn.calls.reduce((sum, call) => sum + call.cost, 0)
      addTurnCost(categories, turn.row.category, turnCost)
      if (skills && turn.row.subCategory) {
        const skill = skills.get(turn.row.subCategory) ?? { cost: 0, savings: 0, turns: 0 }
        skill.cost += turnCost
        skill.savings += turn.calls.reduce((sum, call) => sum + (call.row.savingsUSD > 0 ? call.row.savingsUSD : 0), 0)
        skill.turns++
        skills.set(turn.row.subCategory, skill)
      }

      for (const pricedCall of turn.calls) {
        const { row, resolvedModel, cost } = pricedCall
        const callSavings = row.savingsUSD > 0 ? row.savingsUSD : 0
        totals.cost += cost
        totals.calls++
        const model =
          row.provider === 'devin'
            ? resolvedModel
            : getShortModelName(resolvedModel, name => resolveModelNameAlias(catalogue, name))
        models[model] = true
        if (dashboardTotals) {
          if (row.isEstimated) dashboardTotals.estimatedCost += cost
          dashboardTotals.savings += callSavings
          dashboardTotals.inputTokens += row.inputTokens
          dashboardTotals.outputTokens += row.outputTokens
          dashboardTotals.cacheReadTokens += row.cacheReadInputTokens
          dashboardTotals.cacheWriteTokens += row.cacheCreationInputTokens
          dashboardTotals.reasoningTokens += row.reasoningTokens
          if (!dashboardTotals.startedAt || row.timestamp < dashboardTotals.startedAt)
            dashboardTotals.startedAt = row.timestamp
          if (!dashboardTotals.endedAt || row.timestamp > dashboardTotals.endedAt)
            dashboardTotals.endedAt = row.timestamp
        }
        if (subagents)
          for (const subagentType of row.subagentTypes) {
            const subagent = subagents.get(subagentType) ?? { cost: 0, savings: 0, calls: 0 }
            subagent.calls++
            subagent.cost += cost
            subagent.savings += callSavings
            subagents.set(subagentType, subagent)
          }
      }
    }

    const provider =
      turns.find(turn => turn.calls[0]?.row.provider)?.calls[0]?.row.provider ??
      providerFromModel(Object.keys(models)[0] ?? '')
    const dashboard = dashboardTotals
      ? {
          ...canonicalSessionProject(session, session.sourceProvider),
          estimatedCost: dashboardTotals.estimatedCost,
          savings: dashboardTotals.savings,
          inputTokens: dashboardTotals.inputTokens,
          outputTokens: dashboardTotals.outputTokens,
          cacheReadTokens: dashboardTotals.cacheReadTokens,
          cacheWriteTokens: dashboardTotals.cacheWriteTokens,
          reasoningTokens: dashboardTotals.reasoningTokens,
          startedAt: dashboardTotals.startedAt,
          endedAt: dashboardTotals.endedAt,
        }
      : undefined
    const analytical =
      skills && subagents ? { skills: Object.fromEntries(skills), subagents: Object.fromEntries(subagents) } : undefined

    sessions.push({
      session,
      models: Object.keys(models),
      provider,
      cost: totals.cost,
      calls: totals.calls,
      categories: Object.fromEntries(categories),
      dashboard,
      analytical,
    })
  }
  sessions.sort((a, b) => a.session.sessionId.localeCompare(b.session.sessionId))
  return { sessions, unpricedModels: [...unpricedModels] }
}

function toCostEntries(sums: Map<string, Sum>): Array<{ name: string; cost: number; calls: number }> {
  return Array.from(sums.entries())
    .map(([name, sum]) => ({ name, cost: sum.cost, calls: sum.calls }))
    .sort((a, b) => b.cost - a.cost)
}

export function calculateDashboardViews(
  data: LedgerViewData,
  input: ViewCalculationInputs,
): ViewCalculationResult<DashboardViews> {
  const calculation = calculateSessions(data, input.catalogue, 'dashboard')
  const costByDay = new Map<string, number>()
  const providerSums = new Map<string, Sum>()
  const modelSums = new Map<string, Sum>()
  const projectSums = new Map<string, Sum>()
  const projectDisplayNames = new Map<string, string>()
  const categorySums = new Map<string, { cost: number; turns: number }>()
  const kpis: DashboardViews['kpis'] = {
    totalCost: 0,
    totalEstimatedCost: 0,
    totalSavings: 0,
    totalProxiedCost: 0,
    totalCalls: 0,
    totalSessions: calculation.sessions.length,
    totalProjects: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalReasoningTokens: 0,
  }
  const projectKeys = new Set<string>()

  for (const session of calculation.sessions) {
    const dashboard = session.dashboard
    if (!dashboard) continue
    const day = dashboard.startedAt.slice(0, 10)
    costByDay.set(day, (costByDay.get(day) ?? 0) + session.cost)
    const provider = providerSums.get(session.provider) ?? emptySum()
    addSession(provider, session)
    providerSums.set(session.provider, provider)
    for (const model of session.models) {
      const sum = modelSums.get(model) ?? emptySum()
      addSession(sum, session)
      modelSums.set(model, sum)
    }
    projectKeys.add(dashboard.projectKey)
    if (!projectDisplayNames.has(dashboard.projectKey)) projectDisplayNames.set(dashboard.projectKey, dashboard.project)
    const project = projectSums.get(dashboard.projectKey) ?? emptySum()
    addSession(project, session)
    projectSums.set(dashboard.projectKey, project)
    for (const [name, category] of Object.entries(session.categories)) {
      const sum = categorySums.get(name) ?? { cost: 0, turns: 0 }
      sum.cost += category.cost
      sum.turns += category.turns
      categorySums.set(name, sum)
    }

    kpis.totalCost += session.cost
    kpis.totalEstimatedCost += dashboard.estimatedCost
    kpis.totalSavings += dashboard.savings
    if (isProxiedPath(session.session.projectPath, input.proxyPaths)) kpis.totalProxiedCost += session.cost
    kpis.totalCalls += session.calls
    kpis.totalInputTokens += dashboard.inputTokens
    kpis.totalOutputTokens += dashboard.outputTokens
    kpis.totalCacheReadTokens += dashboard.cacheReadTokens
    kpis.totalCacheWriteTokens += dashboard.cacheWriteTokens
    kpis.totalReasoningTokens += dashboard.reasoningTokens
  }
  kpis.totalProjects = projectKeys.size

  const byCost = (a: { cost: number }, b: { cost: number }): number => b.cost - a.cost
  const value: DashboardViews = {
    kpis,
    costOverTime: Array.from(costByDay.entries())
      .map(([date, cost]) => ({ date, cost }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    byProvider: Array.from(providerSums.entries())
      .map(([name, sum]) => ({ name, cost: sum.cost, calls: sum.calls, sessions: sum.sessions }))
      .sort(byCost),
    byModel: toCostEntries(modelSums),
    byProject: toCostEntries(projectSums).map(entry => ({
      ...entry,
      name: projectDisplayNames.get(entry.name) ?? entry.name,
    })),
    byCategory: Array.from(categorySums.entries())
      .filter(([, sum]) => sum.cost !== 0 || sum.turns !== 0)
      .map(([category, sum]) => ({ name: CATEGORY_LABELS[category as TaskCategory] ?? category, ...sum }))
      .sort(byCost),
  }
  return { value, unpricedModels: calculation.unpricedModels }
}

export function calculateAnalyticalViews(
  data: LedgerViewData,
  input: ViewCalculationInputs,
): ViewCalculationResult<AnalyticalViews> {
  const calculation = calculateSessions(data, input.catalogue, 'analytical')
  const providerSums = new Map<string, Sum>()
  const modelSums = new Map<string, Sum>()
  const categorySums = new Map<string, { cost: number; turns: number }>()
  const skillSums = new Map<string, { cost: number; savings: number; turns: number }>()
  const subagentSums = new Map<string, { cost: number; savings: number; calls: number }>()

  for (const session of calculation.sessions) {
    const analytical = session.analytical
    if (!analytical) continue
    const provider = providerSums.get(session.provider) ?? emptySum()
    addSession(provider, session)
    providerSums.set(session.provider, provider)
    for (const model of session.models) {
      const sum = modelSums.get(model) ?? emptySum()
      addSession(sum, session)
      modelSums.set(model, sum)
    }
    for (const [name, category] of Object.entries(session.categories)) {
      const sum = categorySums.get(name) ?? { cost: 0, turns: 0 }
      sum.cost += category.cost
      sum.turns += category.turns
      categorySums.set(name, sum)
    }
    for (const [name, skill] of Object.entries(analytical.skills)) {
      const sum = skillSums.get(name) ?? { cost: 0, savings: 0, turns: 0 }
      sum.cost += skill.cost
      sum.savings += skill.savings
      sum.turns += skill.turns
      skillSums.set(name, sum)
    }
    for (const [name, subagent] of Object.entries(analytical.subagents)) {
      const sum = subagentSums.get(name) ?? { cost: 0, savings: 0, calls: 0 }
      sum.cost += subagent.cost
      sum.savings += subagent.savings
      sum.calls += subagent.calls
      subagentSums.set(name, sum)
    }
  }

  const byCost = (a: { cost: number }, b: { cost: number }): number => b.cost - a.cost
  return {
    value: {
      providers: Array.from(providerSums.entries())
        .map(([name, sum]) => ({ name, cost: sum.cost, calls: sum.calls, sessions: sum.sessions }))
        .sort(byCost),
      models: toCostEntries(modelSums),
      categories: Array.from(categorySums.entries())
        .filter(([, sum]) => sum.cost !== 0 || sum.turns !== 0)
        .map(([category, sum]) => ({ name: CATEGORY_LABELS[category as TaskCategory] ?? category, ...sum }))
        .sort(byCost),
      skills: Array.from(skillSums.entries())
        .filter(([, sum]) => sum.cost !== 0 || sum.turns !== 0)
        .map(([name, sum]) => ({ name, turns: sum.turns, cost: sum.cost, savingsUSD: sum.savings }))
        .sort(byCost),
      subagents: Array.from(subagentSums.entries())
        .filter(([, sum]) => sum.cost !== 0 || sum.calls !== 0)
        .map(([name, sum]) => ({ name, calls: sum.calls, cost: sum.cost, savingsUSD: sum.savings }))
        .sort(byCost),
    },
    unpricedModels: calculation.unpricedModels,
  }
}
