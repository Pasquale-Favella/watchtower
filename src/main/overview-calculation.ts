import {
  type EfficiencyGrade,
  type OverviewActivityRow,
  type OverviewDailyEntry,
  type OverviewKpis,
  type OverviewLocalModelSavings,
  type OverviewMcpRow,
  type OverviewModelRow,
  type OverviewPayload,
  type OverviewRetryTax,
  type OverviewReworkedFile,
  type OverviewRoutingWaste,
  type OverviewScope,
  type OverviewSkillRow,
  type OverviewSubagentRow,
  type OverviewToolRow,
  type OverviewUnpricedModel,
} from '../shared/schemas/overview.js'
import { inScope, localDateKey, overviewDateRange, periodWindowStart, sessionFirstDateKey } from './overview-scope.js'
import { EDIT_TOOLS } from './pipeline/classifier.js'
import { getShortModelName } from './pipeline/model-names.js'
import {
  calculateRepricedCostResult,
  createPricingConfigLookup,
  findUnpricedModels,
  isExpectedFreeModel,
  type LocalModelSavings,
  type PricingCatalogue,
  resolveModelNameAlias,
} from './pipeline/pricing-calculation.js'
import { CATEGORY_LABELS, type SessionSummary, type TaskCategory } from './pipeline/types.js'
import { buildSessionSummariesFromSnapshotResult, queryScopeFromSnapshotResult } from './store/aggregate-calculation.js'
import type { LedgerQuerySnapshot } from './store/ledger-query-snapshot.js'
import type { OverviewReadCall, OverviewReadData, OverviewReadTurn } from './store/overview-read-projections.js'

// User-side correction mirror.
const USER_CORRECTION_PATTERNS: RegExp[] = [
  /\bthat'?s (?:not|n'?t) (?:what|right|correct|it)\b/i,
  /\bthat'?s (?:wrong|incorrect)\b/i,
  /\bthat is (?:wrong|incorrect|not right)\b/i,
  /\bnot what I (?:meant|wanted|asked|said)\b/i,
  /\bno,? I (?:meant|wanted|said|asked for)\b/i,
  /\byou (?:missed|forgot|misunderstood|broke)\b/i,
  /\brevert (?:that|it|this|your|the last|the change)\b/i,
  /\bundo (?:that|it|this|your|the last|the change)\b/i,
  /\bwrong (?:file|approach|place|method|function|answer|way|direction)\b/i,
  /\bstill (?:wrong|broken|failing|not working)\b/i,
]

function matchesCorrection(text: string): boolean {
  return USER_CORRECTION_PATTERNS.some(p => p.test(text))
}

function scanCorrections(sessions: SessionSummary[]): {
  corrections: number
  userTurns: number
  correctionRate: number | null
} {
  let corrections = 0
  let userTurns = 0
  for (const sess of sessions) {
    let sawPrompt = false
    for (const turn of sess.turns) {
      const msg = turn.userMessage
      if (!msg || !msg.trim()) continue
      userTurns++
      if (!sawPrompt) {
        sawPrompt = true
        continue
      }
      if (matchesCorrection(msg)) corrections++
    }
  }
  return { corrections, userTurns, correctionRate: userTurns > 0 ? corrections / userTurns : null }
}

function callHasEditTools(tools: string[]): boolean {
  return tools.some(t => EDIT_TOOLS.has(t))
}

function sessionTimeToFirstEditMs(sess: SessionSummary): number | null {
  const startMs = Date.parse(sess.turns[0]?.timestamp ?? '')
  if (Number.isNaN(startMs)) return null
  for (const turn of sess.turns) {
    for (const call of turn.assistantCalls) {
      if (!callHasEditTools(call.tools)) continue
      const editMs = Date.parse(call.timestamp)
      if (Number.isNaN(editMs)) return null
      return Math.max(0, editMs - startMs)
    }
  }
  return null
}

function medianTimeToFirstEditMs(sessions: SessionSummary[]): number | null {
  const samples: number[] = []
  for (const sess of sessions) {
    const ms = sessionTimeToFirstEditMs(sess)
    if (ms !== null) samples.push(ms)
  }
  if (samples.length === 0) return null
  samples.sort((a, b) => a - b)
  const mid = Math.floor(samples.length / 2)
  const upper = samples[mid]
  if (upper === undefined) return null
  if (samples.length % 2 !== 0) return upper
  const lower = samples[mid - 1]
  return lower === undefined ? null : (lower + upper) / 2
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/')
}

function basename(p: string): string {
  const normalized = normalizeSlashes(p)
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized
}

function aggregateFileChurn(sessions: SessionSummary[], limit = 15): OverviewReworkedFile[] {
  type Acc = { path: string; sessions: Set<string>; edits: number }
  const byPath = new Map<string, Acc>()
  for (const sess of sessions) {
    for (const turn of sess.turns) {
      for (const call of turn.assistantCalls) {
        if (!call.toolSequence) continue
        for (const step of call.toolSequence) {
          for (const tc of step) {
            if (!EDIT_TOOLS.has(tc.tool) || !tc.file) continue
            const file = normalizeSlashes(tc.file)
            let acc = byPath.get(file)
            if (!acc) {
              acc = { path: basename(file), sessions: new Set(), edits: 0 }
              byPath.set(file, acc)
            }
            acc.sessions.add(sess.sessionId)
            acc.edits++
          }
        }
      }
    }
  }
  return [...byPath.values()]
    .map(a => ({ path: a.path, sessions: a.sessions.size, edits: a.edits }))
    .sort((a, b) => b.sessions - a.sessions || b.edits - a.edits || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, limit)
}

function oneShotRateFor(editTurns: number, oneShotTurns: number): number | null {
  if (editTurns === 0) return null
  return oneShotTurns / editTurns
}

function cacheHitPercent(inputTokens: number, cacheReadTokens: number): number {
  const denom = inputTokens + cacheReadTokens
  if (denom === 0) return 0
  return (cacheReadTokens / denom) * 100
}

function computePricingCoverage(totalCostBearingCalls: number, unpricedCalls: number): number {
  if (totalCostBearingCalls <= 0) return 1
  const priced = Math.max(0, totalCostBearingCalls - unpricedCalls)
  return priced / totalCostBearingCalls
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function efficiencyGrade(score: number): EfficiencyGrade {
  if (score >= 93) return 'A+'
  if (score >= 85) return 'A'
  if (score >= 75) return 'B'
  if (score >= 65) return 'C'
  if (score >= 55) return 'D'
  return 'F'
}

type ModelEfficiencyAcc = {
  model: string
  editTurns: number
  oneShotTurns: number
  retries: number
  editCostUSD: number
  oneShotRate: number | null
  retriesPerEdit: number | null
  costPerEditUSD: number | null
}

function modelKey(
  call: SessionSummary['turns'][number]['assistantCalls'][number],
  catalogue: PricingCatalogue,
): string {
  return call.provider === 'devin'
    ? call.model
    : getShortModelName(call.model, model => resolveModelNameAlias(catalogue, model))
}

function aggregateModelEfficiency(
  sessions: SessionSummary[],
  catalogue: PricingCatalogue,
): Map<string, ModelEfficiencyAcc> {
  const byModel = new Map<string, ModelEfficiencyAcc>()
  function ensure(model: string): ModelEfficiencyAcc {
    let stats = byModel.get(model)
    if (!stats) {
      stats = {
        model,
        editTurns: 0,
        oneShotTurns: 0,
        retries: 0,
        editCostUSD: 0,
        oneShotRate: null,
        retriesPerEdit: null,
        costPerEditUSD: null,
      }
      byModel.set(model, stats)
    }
    return stats
  }
  for (const sess of sessions) {
    for (const turn of sess.turns) {
      if (!turn.hasEdits || turn.assistantCalls.length === 0) continue
      const primaryCall = turn.assistantCalls.find(c => modelKey(c, catalogue) !== '<synthetic>')
      if (!primaryCall) continue
      const stats = ensure(modelKey(primaryCall, catalogue))
      stats.editTurns++
      if (turn.retries === 0) stats.oneShotTurns++
      stats.retries += turn.retries
      stats.editCostUSD += turn.assistantCalls.reduce((sum, call) => {
        return modelKey(call, catalogue) === '<synthetic>' ? sum : sum + call.costUSD
      }, 0)
    }
  }
  for (const stats of byModel.values()) {
    stats.oneShotRate = stats.editTurns > 0 ? Math.round((stats.oneShotTurns / stats.editTurns) * 1000) / 10 : null
    stats.retriesPerEdit = stats.editTurns > 0 ? Math.round((stats.retries / stats.editTurns) * 10) / 10 : null
    stats.costPerEditUSD = stats.editTurns > 0 ? stats.editCostUSD / stats.editTurns : null
  }
  return byModel
}

const RETRY_TAX_LIMIT = 5
const ROUTING_WASTE_LIMIT = 5
const TOP_RANK_LIMIT = 10

/** Diagnostics returned alongside a payload calculated from a ledger snapshot. */
export type OverviewSnapshotCalculationResult = { value: OverviewPayload; unpricedModels: readonly string[] }

export type OverviewCalculationInput = {
  sessions: SessionSummary[]
  scope: OverviewScope
  now: Date
  dataStart: string | null
  catalogue: PricingCatalogue
  localSavings: LocalModelSavings
}

function dataStartFromSnapshot(snapshot: LedgerQuerySnapshot, now: Date): string | null {
  const lifetimeRange = overviewDateRange({ period: 'lifetime' }, now)
  const sessionKeys = new Set(snapshot.sessions.map(session => `${session.sourceId}\0${session.sessionId}`))
  const callsByTurn = new Map<string, LedgerQuerySnapshot['calls'][number][]>()

  for (const call of snapshot.calls) {
    const key = `${call.sourceId}\0${call.sessionId}\0${call.turnIndex}`
    const calls = callsByTurn.get(key)
    if (calls) calls.push(call)
    else callsByTurn.set(key, [call])
  }

  type AdmittedTurn = {
    readonly timestamp: string
    readonly firstCallMillis: number
    readonly calls: LedgerQuerySnapshot['calls'][number][]
  }
  const turnsBySession = new Map<string, AdmittedTurn[]>()
  for (const turn of snapshot.turns) {
    const sessionKey = `${turn.sourceId}\0${turn.sessionId}`
    if (!sessionKeys.has(sessionKey)) continue
    const calls = callsByTurn.get(`${sessionKey}\0${turn.turnIndex}`) ?? []
    calls.sort((a, b) => a.callIndex - b.callIndex)
    const firstCall = calls[0]
    if (!firstCall) continue
    const firstCallMillis = Date.parse(firstCall.timestamp)
    if (
      Number.isNaN(firstCallMillis) ||
      firstCallMillis < lifetimeRange.start.getTime() ||
      firstCallMillis > lifetimeRange.end.getTime()
    )
      continue
    const admitted = { timestamp: turn.timestamp, firstCallMillis, calls }
    const turns = turnsBySession.get(sessionKey)
    if (turns) turns.push(admitted)
    else turnsBySession.set(sessionKey, [admitted])
  }

  let earliest: string | null = null
  for (const turns of turnsBySession.values()) {
    turns.sort((a, b) => a.firstCallMillis - b.firstCallMillis || a.timestamp.localeCompare(b.timestamp))
    // Whole-turn admission and session timestamp selection are separate rules.
    // Preserve assembleSession's lexical comparison and empty-value fallback.
    let firstTimestamp = ''
    for (const turn of turns) {
      for (const call of turn.calls) {
        if (!firstTimestamp || call.timestamp < firstTimestamp) firstTimestamp = call.timestamp
      }
    }
    const millis = Date.parse(firstTimestamp || turns[0]?.timestamp || '')
    if (Number.isNaN(millis)) continue
    const key = localDateKey(new Date(millis))
    if (earliest === null || key < earliest) earliest = key
  }
  return earliest
}

/** Pure Overview calculation over explicit summaries and captured pricing. */
export function calculateOverviewPayload(input: OverviewCalculationInput): OverviewPayload {
  const { scope, now, dataStart, catalogue, localSavings } = input
  const getDisplayModelName = (model: string): string =>
    getShortModelName(model, name => resolveModelNameAlias(catalogue, name))
  const provider = scope.provider
  const sessions = input.sessions.filter(session => inScope(session, scope, now, provider))

  const kpis: OverviewKpis = {
    cost: 0,
    calls: 0,
    sessions: sessions.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    savingsUSD: 0,
    estimatedCostUSD: 0,
    oneShotRate: null,
    cacheHitPercent: 0,
  }

  const categoryTotals = new Map<
    string,
    { turns: number; cost: number; savingsUSD: number; editTurns: number; oneShotTurns: number }
  >()
  const modelTotals = new Map<
    string,
    {
      calls: number
      cost: number
      savingsUSD: number
      estimatedCostUSD: number
      inputTokens: number
      outputTokens: number
      allTokens: number
    }
  >()
  const modelProvenance = new Map<string, Set<string>>()
  const toolTotals = new Map<string, number>()
  const mcpTotals = new Map<string, number>()
  const skillTotals = new Map<string, { turns: number; cost: number }>()
  const subagentTotals = new Map<string, { calls: number; cost: number }>()
  const dayBuckets = new Map<string, { cost: number; calls: number; sessions: number }>()

  const savingsByModel = new Map<
    string,
    {
      calls: number
      actualUSD: number
      savingsUSD: number
      baselineModel: string
      inputTokens: number
      outputTokens: number
    }
  >()
  const savingsByProvider = new Map<string, { calls: number; savingsUSD: number }>()
  let totalSavings = 0
  let totalSavingsCalls = 0

  for (const sess of sessions) {
    kpis.cost += sess.totalCostUSD
    kpis.calls += sess.apiCalls
    kpis.inputTokens += sess.totalInputTokens
    kpis.outputTokens += sess.totalOutputTokens
    kpis.cacheReadTokens += sess.totalCacheReadTokens
    kpis.cacheWriteTokens += sess.totalCacheWriteTokens
    kpis.savingsUSD += sess.totalSavingsUSD
    kpis.estimatedCostUSD += sess.totalEstimatedCostUSD ?? 0

    const dayKey = sessionFirstDateKey(sess)
    if (dayKey) {
      const day = dayBuckets.get(dayKey) ?? { cost: 0, calls: 0, sessions: 0 }
      day.cost += sess.totalCostUSD
      day.calls += sess.apiCalls
      day.sessions += 1
      dayBuckets.set(dayKey, day)
    }

    for (const [category, d] of Object.entries(sess.categoryBreakdown)) {
      const acc = categoryTotals.get(category) ?? { turns: 0, cost: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
      acc.turns += d.turns
      acc.cost += d.costUSD
      acc.savingsUSD += d.savingsUSD
      acc.editTurns += d.editTurns
      acc.oneShotTurns += d.oneShotTurns
      categoryTotals.set(category, acc)
    }

    for (const [model, d] of Object.entries(sess.modelBreakdown)) {
      if (model === '<synthetic>') continue
      const name = getDisplayModelName(model)
      const acc = modelTotals.get(name) ?? {
        calls: 0,
        cost: 0,
        savingsUSD: 0,
        estimatedCostUSD: 0,
        inputTokens: 0,
        outputTokens: 0,
        allTokens: 0,
      }
      acc.calls += d.calls
      acc.cost += d.costUSD
      acc.savingsUSD += d.savingsUSD
      acc.estimatedCostUSD += d.estimatedCostUSD ?? 0
      acc.inputTokens += d.tokens.inputTokens
      acc.outputTokens += d.tokens.outputTokens
      acc.allTokens +=
        d.tokens.inputTokens + d.tokens.outputTokens + d.tokens.cacheReadInputTokens + d.tokens.cacheCreationInputTokens
      modelTotals.set(name, acc)
      if (d.sourceModels?.length) {
        let set = modelProvenance.get(name)
        if (!set) {
          set = new Set<string>()
          modelProvenance.set(name, set)
        }
        for (const raw of d.sourceModels) set.add(raw)
      }
    }

    for (const [tool, d] of Object.entries(sess.toolBreakdown)) {
      if (tool.startsWith('lang:')) continue
      toolTotals.set(tool, (toolTotals.get(tool) ?? 0) + d.calls)
    }
    for (const [server, d] of Object.entries(sess.mcpBreakdown)) {
      mcpTotals.set(server, (mcpTotals.get(server) ?? 0) + d.calls)
    }
    for (const [skill, d] of Object.entries(sess.skillBreakdown)) {
      const acc = skillTotals.get(skill) ?? { turns: 0, cost: 0 }
      acc.turns += d.turns
      acc.cost += d.costUSD
      skillTotals.set(skill, acc)
    }
    for (const [subagent, d] of Object.entries(sess.subagentBreakdown)) {
      const acc = subagentTotals.get(subagent) ?? { calls: 0, cost: 0 }
      acc.calls += d.calls
      acc.cost += d.costUSD
      subagentTotals.set(subagent, acc)
    }

    for (const turn of sess.turns) {
      for (const call of turn.assistantCalls) {
        if (!call.savingsUSD || call.savingsUSD <= 0) continue
        totalSavings += call.savingsUSD
        totalSavingsCalls += 1
        const name = getDisplayModelName(call.model)
        const acc = savingsByModel.get(name) ?? {
          calls: 0,
          actualUSD: 0,
          savingsUSD: 0,
          baselineModel: call.savingsBaselineModel ?? '',
          inputTokens: 0,
          outputTokens: 0,
        }
        acc.calls += 1
        acc.actualUSD += call.costUSD
        acc.savingsUSD += call.savingsUSD
        if (!acc.baselineModel) acc.baselineModel = call.savingsBaselineModel ?? ''
        acc.inputTokens += call.usage.inputTokens
        acc.outputTokens += call.usage.outputTokens
        savingsByModel.set(name, acc)
        const provAcc = savingsByProvider.get(call.provider) ?? { calls: 0, savingsUSD: 0 }
        provAcc.calls += 1
        provAcc.savingsUSD += call.savingsUSD
        savingsByProvider.set(call.provider, provAcc)
      }
    }
  }

  // Aggregate one-shot rate and cache-hit percent across the whole window.
  let edits = 0
  let oneShots = 0
  for (const acc of categoryTotals.values()) {
    edits += acc.editTurns
    oneShots += acc.oneShotTurns
  }
  kpis.oneShotRate = edits > 0 ? oneShots / edits : null
  kpis.cacheHitPercent = cacheHitPercent(kpis.inputTokens, kpis.cacheReadTokens)

  // Daily chart: contiguous zero-filled calendar window. A custom range spans
  // [since..until]; otherwise the trend covers at least the last 30 days,
  // extended back to the earliest active day already in the period window
  // (the chart always spans the full window).
  const todayKey = localDateKey(now)
  const daily: OverviewDailyEntry[] = []
  if (scope.range) {
    daily.push(...contiguousDaily(dayBuckets, scope.range.since, scope.range.until))
  } else {
    const defaultChartStart = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29))
    const periodStart = periodWindowStart(scope.period, now)
    let earliestInPeriod: string | null = null
    for (const key of dayBuckets.keys()) {
      if (key < periodStart || key > todayKey) continue
      if (earliestInPeriod === null || key < earliestInPeriod) earliestInPeriod = key
    }
    const startKey =
      earliestInPeriod !== null && earliestInPeriod < defaultChartStart ? earliestInPeriod : defaultChartStart
    daily.push(...contiguousDaily(dayBuckets, startKey, todayKey))
  }

  const models: OverviewModelRow[] = [...modelTotals.entries()]
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([name, d]) => {
      const raws = modelProvenance.get(name)
      return {
        name,
        cost: d.cost,
        calls: d.calls,
        inputTokens: d.inputTokens,
        outputTokens: d.outputTokens,
        savingsUSD: d.savingsUSD,
        ...(raws && raws.size > 0 ? { sourceModels: [...raws].sort() } : {}),
      }
    })
    .slice(0, TOP_RANK_LIMIT)

  const activities: OverviewActivityRow[] = [...categoryTotals.entries()]
    .filter(([, d]) => d.turns > 0 || d.cost > 0)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([category, d]) => ({
      name: CATEGORY_LABELS[category as TaskCategory] ?? category,
      cost: d.cost,
      turns: d.turns,
      oneShotRate: oneShotRateFor(d.editTurns, d.oneShotTurns),
    }))
    .slice(0, TOP_RANK_LIMIT)

  const tools: OverviewToolRow[] = [...toolTotals.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([name, calls]) => ({ name, calls }))
    .slice(0, TOP_RANK_LIMIT)

  const mcpServers: OverviewMcpRow[] = [...mcpTotals.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([name, calls]) => ({ name, calls }))
    .slice(0, TOP_RANK_LIMIT)

  const skills: OverviewSkillRow[] = [...skillTotals.entries()]
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([name, d]) => ({ name, turns: d.turns, cost: d.cost }))
    .slice(0, TOP_RANK_LIMIT)

  const subagents: OverviewSubagentRow[] = [...subagentTotals.entries()]
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([name, d]) => ({ name, calls: d.calls, cost: d.cost }))
    .slice(0, TOP_RANK_LIMIT)

  // Efficiency signals.
  const effMap = aggregateModelEfficiency(sessions, catalogue)

  const retryTaxByModel = [...effMap.values()]
    .filter(m => m.retries > 0 && m.editTurns > 0)
    .map(m => ({
      name: m.model,
      taxUSD: m.retries * (m.editCostUSD / m.editTurns),
      retries: m.retries,
      retriesPerEdit: m.retriesPerEdit,
    }))
    .sort((a, b) => b.taxUSD - a.taxUSD)
  const retryTax: OverviewRetryTax = {
    totalUSD: retryTaxByModel.reduce((s, m) => s + m.taxUSD, 0),
    retries: retryTaxByModel.reduce((s, m) => s + m.retries, 0),
    editTurns: [...effMap.values()].filter(m => m.retries > 0).reduce((s, m) => s + m.editTurns, 0),
    byModel: retryTaxByModel.slice(0, RETRY_TAX_LIMIT),
  }

  const reliableModels = [...effMap.values()]
    .filter(m => m.oneShotRate !== null && m.oneShotRate >= 90 && m.editTurns >= 5 && (m.costPerEditUSD ?? 0) >= 0.01)
    .sort((a, b) => (a.costPerEditUSD ?? Infinity) - (b.costPerEditUSD ?? Infinity))
  const baseline = reliableModels[0]
  const routingWasteByModel = baseline
    ? [...effMap.values()]
        .filter(
          m =>
            m.model !== baseline.model && m.editTurns > 0 && (m.costPerEditUSD ?? 0) > (baseline.costPerEditUSD ?? 0),
        )
        .map(m => {
          const counterfactual = m.editTurns * (baseline.costPerEditUSD ?? 0)
          return {
            name: m.model,
            actualUSD: m.editCostUSD,
            counterfactualUSD: counterfactual,
            savingsUSD: m.editCostUSD - counterfactual,
          }
        })
        .filter(m => m.savingsUSD > 0)
        .sort((a, b) => b.savingsUSD - a.savingsUSD)
    : []
  const routingWaste: OverviewRoutingWaste = {
    totalSavingsUSD: routingWasteByModel.reduce((s, m) => s + m.savingsUSD, 0),
    baselineModel: baseline?.model ?? '',
    baselineCostPerEdit: baseline?.costPerEditUSD ?? 0,
    byModel: routingWasteByModel.slice(0, ROUTING_WASTE_LIMIT),
  }

  const unpricedModels: OverviewUnpricedModel[] = findUnpricedModels(
    catalogue,
    localSavings,
    [...modelTotals.entries()].map(([model, d]) => ({ model, calls: d.calls, cost: d.cost, tokens: d.allTokens })),
  )
  let costBearingCalls = 0
  for (const [model, d] of modelTotals) {
    if (model === '<synthetic>' || isExpectedFreeModel(catalogue, localSavings, model)) continue
    costBearingCalls += d.calls
  }
  const unpricedCalls = unpricedModels.reduce((s, m) => s + m.calls, 0)
  const pricingCoverage = computePricingCoverage(costBearingCalls, unpricedCalls)

  const oneShot = kpis.oneShotRate ?? 0.6
  const cacheFrac = clamp(kpis.cacheHitPercent / 100, 0, 1)
  const retrySpendFraction = retryTax.totalUSD / Math.max(kpis.cost, 1e-9)
  const retryPenalty = clamp(retrySpendFraction * 4, 0, 1)
  const score = 100 * (0.45 * oneShot + 0.3 * cacheFrac + 0.25 * (1 - retryPenalty))

  const corrections = scanCorrections(sessions)

  const localModelSavings: OverviewLocalModelSavings = {
    totalUSD: totalSavings,
    calls: totalSavingsCalls,
    byModel: [...savingsByModel.entries()]
      .sort(([, a], [, b]) => b.savingsUSD - a.savingsUSD)
      .slice(0, RETRY_TAX_LIMIT)
      .map(([name, d]) => ({ name, ...d })),
    byProvider: [...savingsByProvider.entries()]
      .sort(([, a], [, b]) => b.savingsUSD - a.savingsUSD)
      .slice(0, RETRY_TAX_LIMIT)
      .map(([name, d]) => ({ name, ...d })),
  }

  return {
    kpis,
    daily,
    dataStart,
    models,
    activities,
    tools,
    mcpServers,
    skills,
    subagents,
    efficiency: {
      score,
      grade: efficiencyGrade(score),
      oneShotRate: kpis.oneShotRate,
      retryTax,
      routingWaste,
      pricingCoverage,
    },
    workflow: {
      ...corrections,
      medianTimeToFirstEditMs: medianTimeToFirstEditMs(sessions),
      topReworkedFiles: aggregateFileChurn(sessions),
    },
    unpricedModels,
    localModelSavings,
  }
}

/** Calculate the scoped payload and lifetime facts from one already-loaded snapshot. */
export function calculateOverviewFromSnapshot(
  snapshot: LedgerQuerySnapshot,
  scope: OverviewScope,
  now: Date,
  localSavings: LocalModelSavings,
): OverviewSnapshotCalculationResult {
  const lifetimeRange = overviewDateRange({ period: 'lifetime' }, now)
  const scoped = buildSessionSummariesFromSnapshotResult(snapshot, {
    range: overviewDateRange(scope, now),
    provider: scope.provider,
  })
  // queryScope prices raw facts before summary assembly and intentionally does
  // not apply the date range. Reuse the scoped names when every source is in
  // scope; otherwise scan the all-source facts without assembling sessions.
  const unpricedModels = scope.provider
    ? queryScopeFromSnapshotResult(snapshot, { range: lifetimeRange }).unpricedModels
    : scoped.unpricedModels
  const value = calculateOverviewPayload({
    sessions: scoped.summaries,
    scope,
    now,
    dataStart: dataStartFromSnapshot(snapshot, now),
    catalogue: snapshot.catalogue,
    localSavings,
  })
  return { value, unpricedModels }
}

function overviewEfficiencyModelKey(provider: string, model: string, catalogue: PricingCatalogue): string {
  return provider === 'devin' ? model : getShortModelName(model, name => resolveModelNameAlias(catalogue, name))
}

type PricedOverviewCall = { row: OverviewReadCall; resolvedModel: string; cost: number }
type OverviewTurnFacts = { row: OverviewReadTurn; calls: PricedOverviewCall[] }
type OverviewSessionFacts = { sessionId: string; sourceProvider: string | null; turns: OverviewTurnFacts[] }

const overviewSessionKey = (sourceId: number, sessionId: string): string => `${sourceId}\0${sessionId}`
const overviewTurnKey = (sourceId: number, sessionId: string, turnIndex: number): string =>
  `${overviewSessionKey(sourceId, sessionId)}\0${turnIndex}`

function calculateOverviewDataStart(sessions: OverviewSessionFacts[], now: Date): string | null {
  const lifetimeRange = overviewDateRange({ period: 'lifetime' }, now)
  let earliest: string | null = null
  for (const session of sessions) {
    let firstTimestamp = ''
    let fallbackTimestamp: string | null = null
    for (const turn of session.turns) {
      const firstCallMillis = Date.parse(turn.calls[0]?.row.timestamp ?? '')
      if (
        !Number.isFinite(firstCallMillis) ||
        firstCallMillis < lifetimeRange.start.getTime() ||
        firstCallMillis > lifetimeRange.end.getTime()
      )
        continue
      if (fallbackTimestamp === null) fallbackTimestamp = turn.row.timestamp
      for (const call of turn.calls) {
        if (!firstTimestamp || call.row.timestamp < firstTimestamp) firstTimestamp = call.row.timestamp
      }
    }
    const millis = Date.parse(firstTimestamp || fallbackTimestamp || '')
    if (!Number.isFinite(millis)) continue
    const key = localDateKey(new Date(millis))
    if (earliest === null || key < earliest) earliest = key
  }
  return earliest
}

function priceOverviewCall(
  row: OverviewReadCall,
  resolvedModel: string,
  pricing: ReturnType<typeof createPricingConfigLookup>,
  catalogue: PricingCatalogue,
): { cost: number; priced: boolean } {
  return calculateRepricedCostResult(catalogue, pricing, {
    model: row.model,
    effectiveModel: resolvedModel,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheWriteTokens: row.cacheCreationInputTokens,
    cacheReadTokens: Math.max(row.cacheReadInputTokens, row.cachedInputTokens),
    webSearchRequests: row.webSearchRequests,
    speed: row.speed,
    recordedCost: row.baseCostUSD,
  })
}

function buildOverviewSessionFacts(
  data: OverviewReadData,
  scope: OverviewScope,
  now: Date,
  catalogue: PricingCatalogue,
): { sessions: OverviewSessionFacts[]; unpricedModels: readonly string[]; dataStart: string | null } {
  const pricing = createPricingConfigLookup(data.aliases, data.overrides)
  const sessions = new Map<string, OverviewSessionFacts>()
  const turns = new Map<string, OverviewTurnFacts>()
  for (const row of data.sessions) {
    sessions.set(overviewSessionKey(row.sourceId, row.sessionId), {
      sessionId: row.sessionId,
      sourceProvider: row.sourceProvider,
      turns: [],
    })
  }

  for (const row of data.turns) {
    const session = sessions.get(overviewSessionKey(row.sourceId, row.sessionId))
    if (!session) continue
    const turn = { row, calls: [] }
    session.turns.push(turn)
    turns.set(overviewTurnKey(row.sourceId, row.sessionId, row.turnIndex), turn)
  }

  const unpricedModels = new Set<string>()
  for (const row of data.calls) {
    const resolvedModel = pricing.resolveAlias(row.model)
    const priced = priceOverviewCall(row, resolvedModel, pricing, catalogue)
    if (!priced.priced) unpricedModels.add(resolvedModel)
    turns.get(overviewTurnKey(row.sourceId, row.sessionId, row.turnIndex))?.calls.push({
      row,
      resolvedModel,
      cost: priced.cost,
    })
  }

  for (const turn of turns.values()) turn.calls.sort((a, b) => a.row.callIndex - b.row.callIndex)
  for (const session of sessions.values()) {
    session.turns.sort((a, b) => {
      const ta = Date.parse(a.calls[0]?.row.timestamp ?? a.row.timestamp)
      const tb = Date.parse(b.calls[0]?.row.timestamp ?? b.row.timestamp)
      return ta - tb || a.row.timestamp.localeCompare(b.row.timestamp)
    })
  }

  const allSessions = [...sessions.values()]
  const dataStart = calculateOverviewDataStart(allSessions, now)
  const range = overviewDateRange(scope, now)
  for (const session of allSessions) {
    session.turns = session.turns.filter(turn => {
      const firstMillis = Date.parse(turn.calls[0]?.row.timestamp ?? '')
      return Number.isFinite(firstMillis) && firstMillis >= range.start.getTime() && firstMillis <= range.end.getTime()
    })
  }
  return {
    sessions: allSessions
      .filter(session => !scope.provider || session.sourceProvider === scope.provider)
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
    unpricedModels: [...unpricedModels],
    dataStart,
  }
}

type NumericMap = Map<string, number>
type ModelTotal = {
  calls: number
  cost: number
  savings: number
  estimated: number
  input: number
  output: number
  allTokens: number
}
type ModelEfficiency = { editTurns: number; oneShotTurns: number; retries: number; editCostUSD: number }

function calculateOverviewFromSessionFacts(
  scope: OverviewScope,
  now: Date,
  catalogue: PricingCatalogue,
  localSavings: LocalModelSavings,
  sessionFacts: OverviewSessionFacts[],
  dataStart: string | null,
): OverviewPayload {
  const getDisplayModelName = (model: string): string =>
    getShortModelName(model, name => resolveModelNameAlias(catalogue, name))
  const kpis: OverviewKpis = {
    cost: 0,
    calls: 0,
    sessions: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    savingsUSD: 0,
    estimatedCostUSD: 0,
    oneShotRate: null,
    cacheHitPercent: 0,
  }
  const categoryTotals = new Map<
    string,
    { turns: number; cost: number; savingsUSD: number; editTurns: number; oneShotTurns: number }
  >()
  const modelTotals = new Map<string, ModelTotal>()
  const modelProvenance = new Map<string, Set<string>>()
  const toolTotals: NumericMap = new Map()
  const mcpTotals: NumericMap = new Map()
  const skillTotals = new Map<string, { turns: number; cost: number }>()
  const subagentTotals = new Map<string, { calls: number; cost: number }>()
  const dayBuckets = new Map<string, { cost: number; calls: number; sessions: number }>()
  const savingsByModel = new Map<
    string,
    {
      calls: number
      actualUSD: number
      savingsUSD: number
      baselineModel: string
      inputTokens: number
      outputTokens: number
    }
  >()
  const savingsByProvider = new Map<string, { calls: number; savingsUSD: number }>()
  const efficiency = new Map<string, ModelEfficiency>()
  const churn = new Map<string, { path: string; sessions: Set<string>; edits: number }>()
  const corrections = { corrections: 0, userTurns: 0 }
  const editSamples: number[] = []
  let totalSavings = 0
  let totalSavingsCalls = 0

  for (const session of sessionFacts) {
    const turns = session.turns
    if (turns.length === 0) continue

    let firstTimestamp = ''
    for (const turn of turns) {
      for (const { row } of turn.calls) {
        if (!firstTimestamp || row.timestamp < firstTimestamp) firstTimestamp = row.timestamp
      }
    }
    firstTimestamp ||= turns[0]?.row.timestamp ?? ''
    const firstMillis = Date.parse(firstTimestamp)
    if (!Number.isFinite(firstMillis)) continue
    const firstDay = localDateKey(new Date(firstMillis))
    if (scope.range) {
      if (firstDay < scope.range.since || firstDay > scope.range.until) continue
    } else {
      const start = periodWindowStart(scope.period, now)
      if (firstDay < start || firstDay > localDateKey(now)) continue
    }
    if (scope.provider && !turns.some(turn => turn.calls.some(call => call.row.provider === scope.provider))) continue

    kpis.sessions++
    let sessionCost = 0
    let sessionCalls = 0
    let sessionSavings = 0
    let sessionEstimatedCost = 0
    let sessionInputTokens = 0
    let sessionOutputTokens = 0
    let sessionCacheReadTokens = 0
    let sessionCacheWriteTokens = 0
    const sessionCategoryTotals = new Map<
      string,
      { turns: number; cost: number; savingsUSD: number; editTurns: number; oneShotTurns: number }
    >()
    const sessionModelTotals = new Map<string, ModelTotal>()
    const sessionModelProvenance = new Map<string, Set<string>>()
    const sessionSkillTotals = new Map<string, { turns: number; cost: number }>()
    const sessionSubagentTotals = new Map<string, { calls: number; cost: number }>()
    let sawPrompt = false
    for (const turn of turns) {
      const turnCost = turn.calls.reduce((sum, call) => sum + call.cost, 0)
      const turnSavings = turn.calls.reduce((sum, call) => sum + call.row.savingsUSD, 0)
      const category = turn.row.category
      const categoryAcc = sessionCategoryTotals.get(category) ?? {
        turns: 0,
        cost: 0,
        savingsUSD: 0,
        editTurns: 0,
        oneShotTurns: 0,
      }
      categoryAcc.turns++
      categoryAcc.cost += turnCost
      categoryAcc.savingsUSD += turnSavings
      if (turn.row.hasEdits === 1) {
        categoryAcc.editTurns++
        if (turn.row.retries === 0) categoryAcc.oneShotTurns++
      }
      sessionCategoryTotals.set(category, categoryAcc)
      if (turn.row.subCategory) {
        const skill = sessionSkillTotals.get(turn.row.subCategory) ?? { turns: 0, cost: 0 }
        skill.turns++
        skill.cost += turnCost
        sessionSkillTotals.set(turn.row.subCategory, skill)
      }

      const prompt = turn.row.userMessage
      if (prompt && prompt.trim()) {
        corrections.userTurns++
        if (sawPrompt && matchesCorrection(prompt)) corrections.corrections++
        sawPrompt = true
      }

      if (turn.row.hasEdits === 1 && turn.calls.length > 0) {
        const primary = turn.calls.find(
          call => overviewEfficiencyModelKey(call.row.provider, call.resolvedModel, catalogue) !== '<synthetic>',
        )
        if (primary) {
          const key = overviewEfficiencyModelKey(primary.row.provider, primary.resolvedModel, catalogue)
          const model = efficiency.get(key) ?? { editTurns: 0, oneShotTurns: 0, retries: 0, editCostUSD: 0 }
          model.editTurns++
          if (turn.row.retries === 0) model.oneShotTurns++
          model.retries += turn.row.retries
          for (const call of turn.calls) {
            const callModel = overviewEfficiencyModelKey(call.row.provider, call.resolvedModel, catalogue)
            if (callModel !== '<synthetic>') model.editCostUSD += call.cost
          }
          efficiency.set(key, model)
        }
      }

      for (const { row, resolvedModel, cost } of turn.calls) {
        const savings = row.savingsUSD > 0 ? row.savingsUSD : 0
        const estimated = row.isEstimated ? cost : 0
        sessionCost += cost
        sessionCalls++
        sessionSavings += row.savingsUSD
        sessionEstimatedCost += estimated
        sessionInputTokens += row.inputTokens
        sessionOutputTokens += row.outputTokens
        sessionCacheReadTokens += row.cacheReadInputTokens
        sessionCacheWriteTokens += row.cacheCreationInputTokens

        const modelKeyName =
          row.provider === 'devin'
            ? resolvedModel
            : getShortModelName(resolvedModel, name => resolveModelNameAlias(catalogue, name))
        if (modelKeyName !== '<synthetic>') {
          const model = sessionModelTotals.get(modelKeyName) ?? {
            calls: 0,
            cost: 0,
            savings: 0,
            estimated: 0,
            input: 0,
            output: 0,
            allTokens: 0,
          }
          model.calls++
          model.cost += cost
          model.savings += row.savingsUSD
          model.estimated += estimated
          model.input += row.inputTokens
          model.output += row.outputTokens
          model.allTokens +=
            row.inputTokens + row.outputTokens + row.cacheReadInputTokens + row.cacheCreationInputTokens
          sessionModelTotals.set(modelKeyName, model)
          if (resolvedModel !== row.model) {
            const sources = sessionModelProvenance.get(modelKeyName) ?? new Set<string>()
            sources.add(row.model)
            sessionModelProvenance.set(modelKeyName, sources)
          }
        }

        for (const tool of row.tools) {
          if (tool.startsWith('lang:') || tool.startsWith('mcp__')) continue
          toolTotals.set(tool, (toolTotals.get(tool) ?? 0) + 1)
        }
        for (const mcp of row.mcpTools) {
          const server = mcp.split('__')[1] ?? mcp
          mcpTotals.set(server, (mcpTotals.get(server) ?? 0) + 1)
        }
        for (const subagent of row.subagentTypes) {
          const total = sessionSubagentTotals.get(subagent) ?? { calls: 0, cost: 0 }
          total.calls++
          total.cost += cost
          sessionSubagentTotals.set(subagent, total)
        }

        if (savings > 0) {
          totalSavings += savings
          totalSavingsCalls++
          const name = getDisplayModelName(resolvedModel)
          const saved = savingsByModel.get(name) ?? {
            calls: 0,
            actualUSD: 0,
            savingsUSD: 0,
            baselineModel: row.savingsBaselineModel ?? '',
            inputTokens: 0,
            outputTokens: 0,
          }
          saved.calls++
          saved.actualUSD += cost
          saved.savingsUSD += savings
          if (!saved.baselineModel) saved.baselineModel = row.savingsBaselineModel ?? ''
          saved.inputTokens += row.inputTokens
          saved.outputTokens += row.outputTokens
          savingsByModel.set(name, saved)
          const provider = savingsByProvider.get(row.provider) ?? { calls: 0, savingsUSD: 0 }
          provider.calls++
          provider.savingsUSD += savings
          savingsByProvider.set(row.provider, provider)
        }

        for (const step of row.toolSequence) {
          for (const toolCall of step) {
            if (!EDIT_TOOLS.has(toolCall.tool) || !toolCall.file) continue
            const file = normalizeSlashes(toolCall.file)
            const item = churn.get(file) ?? { path: basename(file), sessions: new Set<string>(), edits: 0 }
            item.sessions.add(session.sessionId)
            item.edits++
            churn.set(file, item)
          }
        }
      }
    }
    kpis.cost += sessionCost
    kpis.calls += sessionCalls
    kpis.inputTokens += sessionInputTokens
    kpis.outputTokens += sessionOutputTokens
    kpis.cacheReadTokens += sessionCacheReadTokens
    kpis.cacheWriteTokens += sessionCacheWriteTokens
    kpis.savingsUSD += sessionSavings
    kpis.estimatedCostUSD += sessionEstimatedCost

    for (const [category, value] of sessionCategoryTotals) {
      const total = categoryTotals.get(category) ?? {
        turns: 0,
        cost: 0,
        savingsUSD: 0,
        editTurns: 0,
        oneShotTurns: 0,
      }
      total.turns += value.turns
      total.cost += value.cost
      total.savingsUSD += value.savingsUSD
      total.editTurns += value.editTurns
      total.oneShotTurns += value.oneShotTurns
      categoryTotals.set(category, total)
    }
    for (const [modelKey, value] of sessionModelTotals) {
      const name = getDisplayModelName(modelKey)
      const total = modelTotals.get(name) ?? {
        calls: 0,
        cost: 0,
        savings: 0,
        estimated: 0,
        input: 0,
        output: 0,
        allTokens: 0,
      }
      total.calls += value.calls
      total.cost += value.cost
      total.savings += value.savings
      total.estimated += value.estimated
      total.input += value.input
      total.output += value.output
      total.allTokens += value.allTokens
      modelTotals.set(name, total)
      const sources = sessionModelProvenance.get(modelKey)
      if (sources?.size) {
        const allSources = modelProvenance.get(name) ?? new Set<string>()
        for (const source of sources) allSources.add(source)
        modelProvenance.set(name, allSources)
      }
    }
    for (const [skillName, value] of sessionSkillTotals) {
      const total = skillTotals.get(skillName) ?? { turns: 0, cost: 0 }
      total.turns += value.turns
      total.cost += value.cost
      skillTotals.set(skillName, total)
    }
    for (const [name, value] of sessionSubagentTotals) {
      const total = subagentTotals.get(name) ?? { calls: 0, cost: 0 }
      total.calls += value.calls
      total.cost += value.cost
      subagentTotals.set(name, total)
    }
    const day = localDateKey(new Date(firstMillis))
    const dayAcc = dayBuckets.get(day) ?? { cost: 0, calls: 0, sessions: 0 }
    dayAcc.cost += sessionCost
    dayAcc.calls += sessionCalls
    dayAcc.sessions++
    dayBuckets.set(day, dayAcc)

    const startMs = Date.parse(turns[0]?.row.timestamp ?? '')
    if (!Number.isNaN(startMs)) {
      let sample: number | null = null
      let foundEdit = false
      for (const turn of turns) {
        for (const call of turn.calls) {
          if (!call.row.tools.some(tool => EDIT_TOOLS.has(tool))) continue
          const editMs = Date.parse(call.row.timestamp)
          if (Number.isNaN(editMs)) {
            foundEdit = true
            sample = null
          } else {
            foundEdit = true
            sample = Math.max(0, editMs - startMs)
          }
          break
        }
        if (foundEdit) break
      }
      if (sample !== null) editSamples.push(sample)
    }
  }

  let edits = 0
  let oneShots = 0
  for (const acc of categoryTotals.values()) {
    edits += acc.editTurns
    oneShots += acc.oneShotTurns
  }
  kpis.oneShotRate = edits > 0 ? oneShots / edits : null
  kpis.cacheHitPercent = cacheHitPercent(kpis.inputTokens, kpis.cacheReadTokens)
  const todayKey = localDateKey(now)
  const daily: OverviewDailyEntry[] = []
  if (scope.range) {
    daily.push(...contiguousDaily(dayBuckets, scope.range.since, scope.range.until))
  } else {
    const defaultChartStart = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29))
    const periodStart = periodWindowStart(scope.period, now)
    let earliestInPeriod: string | null = null
    for (const key of dayBuckets.keys()) {
      if (key < periodStart || key > todayKey) continue
      if (earliestInPeriod === null || key < earliestInPeriod) earliestInPeriod = key
    }
    const startKey =
      earliestInPeriod !== null && earliestInPeriod < defaultChartStart ? earliestInPeriod : defaultChartStart
    daily.push(...contiguousDaily(dayBuckets, startKey, todayKey))
  }
  const models: OverviewModelRow[] = [...modelTotals.entries()]
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([name, value]) => {
      const sources = modelProvenance.get(name)
      return {
        name,
        cost: value.cost,
        calls: value.calls,
        inputTokens: value.input,
        outputTokens: value.output,
        savingsUSD: value.savings,
        ...(sources && sources.size > 0 ? { sourceModels: [...sources].sort() } : {}),
      }
    })
    .slice(0, TOP_RANK_LIMIT)
  const activities: OverviewActivityRow[] = [...categoryTotals.entries()]
    .filter(([, value]) => value.turns > 0 || value.cost > 0)
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([category, value]) => ({
      name: CATEGORY_LABELS[category as TaskCategory] ?? category,
      cost: value.cost,
      turns: value.turns,
      oneShotRate: oneShotRateFor(value.editTurns, value.oneShotTurns),
    }))
    .slice(0, TOP_RANK_LIMIT)
  const tools: OverviewToolRow[] = [...toolTotals.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([name, calls]) => ({ name, calls }))
    .slice(0, TOP_RANK_LIMIT)
  const mcpServers: OverviewMcpRow[] = [...mcpTotals.entries()]
    .sort(([, a], [, b]) => b - a)
    .map(([name, calls]) => ({ name, calls }))
    .slice(0, TOP_RANK_LIMIT)
  const skills: OverviewSkillRow[] = [...skillTotals.entries()]
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([name, value]) => ({ name, turns: value.turns, cost: value.cost }))
    .slice(0, TOP_RANK_LIMIT)
  const subagents: OverviewSubagentRow[] = [...subagentTotals.entries()]
    .sort(([, a], [, b]) => b.cost - a.cost)
    .map(([name, value]) => ({ name, calls: value.calls, cost: value.cost }))
    .slice(0, TOP_RANK_LIMIT)

  const efficiencyRows = [...efficiency.entries()].map(([model, value]) => ({
    model,
    ...value,
    oneShotRate: value.editTurns > 0 ? Math.round((value.oneShotTurns / value.editTurns) * 1000) / 10 : null,
    retriesPerEdit: value.editTurns > 0 ? Math.round((value.retries / value.editTurns) * 10) / 10 : null,
    costPerEditUSD: value.editTurns > 0 ? value.editCostUSD / value.editTurns : null,
  }))
  const retryTaxByModel = efficiencyRows
    .filter(m => m.retries > 0 && m.editTurns > 0)
    .map(m => ({
      name: m.model,
      taxUSD: m.retries * (m.editCostUSD / m.editTurns),
      retries: m.retries,
      retriesPerEdit: m.retriesPerEdit,
    }))
    .sort((a, b) => b.taxUSD - a.taxUSD)
  const retryTax: OverviewRetryTax = {
    totalUSD: retryTaxByModel.reduce((sum, row) => sum + row.taxUSD, 0),
    retries: retryTaxByModel.reduce((sum, row) => sum + row.retries, 0),
    editTurns: efficiencyRows.filter(m => m.retries > 0).reduce((sum, m) => sum + m.editTurns, 0),
    byModel: retryTaxByModel.slice(0, RETRY_TAX_LIMIT),
  }
  const reliableModels = efficiencyRows
    .filter(m => m.oneShotRate !== null && m.oneShotRate >= 90 && m.editTurns >= 5 && (m.costPerEditUSD ?? 0) >= 0.01)
    .sort((a, b) => (a.costPerEditUSD ?? Infinity) - (b.costPerEditUSD ?? Infinity))
  const baseline = reliableModels[0]
  const routingWasteByModel = baseline
    ? efficiencyRows
        .filter(
          m =>
            m.model !== baseline.model && m.editTurns > 0 && (m.costPerEditUSD ?? 0) > (baseline.costPerEditUSD ?? 0),
        )
        .map(m => {
          const counterfactual = m.editTurns * (baseline.costPerEditUSD ?? 0)
          return {
            name: m.model,
            actualUSD: m.editCostUSD,
            counterfactualUSD: counterfactual,
            savingsUSD: m.editCostUSD - counterfactual,
          }
        })
        .filter(m => m.savingsUSD > 0)
        .sort((a, b) => b.savingsUSD - a.savingsUSD)
    : []
  const routingWaste: OverviewRoutingWaste = {
    totalSavingsUSD: routingWasteByModel.reduce((sum, row) => sum + row.savingsUSD, 0),
    baselineModel: baseline?.model ?? '',
    baselineCostPerEdit: baseline?.costPerEditUSD ?? 0,
    byModel: routingWasteByModel.slice(0, ROUTING_WASTE_LIMIT),
  }
  const unpricedModels: OverviewUnpricedModel[] = findUnpricedModels(
    catalogue,
    localSavings,
    [...modelTotals.entries()].map(([model, value]) => ({
      model,
      calls: value.calls,
      cost: value.cost,
      tokens: value.allTokens,
    })),
  )
  let costBearingCalls = 0
  for (const [model, value] of modelTotals) {
    if (model === '<synthetic>' || isExpectedFreeModel(catalogue, localSavings, model)) continue
    costBearingCalls += value.calls
  }
  const pricingCoverage = computePricingCoverage(
    costBearingCalls,
    unpricedModels.reduce((sum, model) => sum + model.calls, 0),
  )
  const oneShot = kpis.oneShotRate ?? 0.6
  const cacheFrac = clamp(kpis.cacheHitPercent / 100, 0, 1)
  const retryPenalty = clamp((retryTax.totalUSD / Math.max(kpis.cost, 1e-9)) * 4, 0, 1)
  const score = 100 * (0.45 * oneShot + 0.3 * cacheFrac + 0.25 * (1 - retryPenalty))
  editSamples.sort((a, b) => a - b)
  const mid = Math.floor(editSamples.length / 2)
  const medianEdit =
    editSamples.length === 0
      ? null
      : editSamples.length % 2 !== 0
        ? (editSamples[mid] ?? null)
        : ((editSamples[mid - 1] ?? 0) + (editSamples[mid] ?? 0)) / 2
  const localModelSavings: OverviewLocalModelSavings = {
    totalUSD: totalSavings,
    calls: totalSavingsCalls,
    byModel: [...savingsByModel.entries()]
      .sort(([, a], [, b]) => b.savingsUSD - a.savingsUSD)
      .slice(0, RETRY_TAX_LIMIT)
      .map(([name, value]) => ({ name, ...value })),
    byProvider: [...savingsByProvider.entries()]
      .sort(([, a], [, b]) => b.savingsUSD - a.savingsUSD)
      .slice(0, RETRY_TAX_LIMIT)
      .map(([name, value]) => ({ name, ...value })),
  }
  const topReworkedFiles: OverviewReworkedFile[] = [...churn.values()]
    .map(value => ({ path: value.path, sessions: value.sessions.size, edits: value.edits }))
    .sort((a, b) => b.sessions - a.sessions || b.edits - a.edits || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, 15)
  return {
    kpis,
    daily,
    dataStart,
    models,
    activities,
    tools,
    mcpServers,
    skills,
    subagents,
    efficiency: {
      score,
      grade: efficiencyGrade(score),
      oneShotRate: kpis.oneShotRate,
      retryTax,
      routingWaste,
      pricingCoverage,
    },
    workflow: {
      corrections: corrections.corrections,
      userTurns: corrections.userTurns,
      correctionRate: corrections.userTurns > 0 ? corrections.corrections / corrections.userTurns : null,
      medianTimeToFirstEditMs: medianEdit,
      topReworkedFiles,
    },
    unpricedModels,
    localModelSavings,
  }
}

/** Direct Overview aggregation over grouped facts, with no pipeline summaries. */
export function calculateOverviewFromData(
  data: OverviewReadData,
  scope: OverviewScope,
  now: Date,
  catalogue: PricingCatalogue,
  localSavings: LocalModelSavings,
): OverviewSnapshotCalculationResult {
  const grouped = buildOverviewSessionFacts(data, scope, now, catalogue)
  return {
    value: calculateOverviewFromSessionFacts(scope, now, catalogue, localSavings, grouped.sessions, grouped.dataStart),
    unpricedModels: grouped.unpricedModels,
  }
}

function contiguousDaily(
  dayBuckets: Map<string, { cost: number; calls: number; sessions: number }>,
  fromKey: string,
  toKey: string,
): OverviewDailyEntry[] {
  if (fromKey > toKey) return []
  const [fy, fm, fd] = fromKey.split('-').map(Number)
  const [ty, tm, td] = toKey.split('-').map(Number)
  const cursor = new Date(fy, fm - 1, fd)
  const end = new Date(ty, tm - 1, td)
  const out: OverviewDailyEntry[] = []
  while (cursor <= end) {
    const key = localDateKey(cursor)
    const bucket = dayBuckets.get(key)
    out.push({ date: key, costUSD: bucket?.cost ?? 0, calls: bucket?.calls ?? 0, sessions: bucket?.sessions ?? 0 })
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}
