import { getShortModelName } from './pipeline/models.js'
import type { SessionSummary } from './pipeline/types.js'
import { overviewDateRange, type OverviewScope } from './overview.js'
import { buildSessionSummaries } from './store/aggregate.js'
import type { LedgerStore } from './store/ledger.js'
import {
  comparePayloadSchema,
  type CategoryComparison,
  type CompareFormatFn,
  type CompareModelStat,
  type ComparePair,
  type ComparePayload,
  type CompareReport,
  type CompareWinner,
  type ComparisonRow,
  type WorkingStyleRow,
} from '../shared/schemas/compare.js'

export type {
  CategoryComparison,
  CompareFormatFn,
  CompareModelStat,
  ComparePair,
  ComparePayload,
  CompareReport,
  CompareWinner,
  ComparisonRow,
  WorkingStyleRow,
} from '../shared/schemas/compare.js'

/** The Compare section's scoped payload (ADR 0008): a model-pair picker, a
 * metrics comparison card, per-category one-shot comparison bars, and a
 * working-style card. The section honors the selected custom date range
 * like every other section (the CLI's range restriction is lifted — no
 * RangeNote): every query applies the shared `inScope` window, and ALL
 * numbers are recomputed query-time per the selected pair (a pair is
 * user-selected, so nothing is pre-materialized for every combination).
 *
 * Two deliberate design decisions, both documented in code:
 * - self-corrections use the desktop's established selfCorrectionRate semantic
 *   (`editTurns / totalTurns`, the same ratio the Overview/Plans report) since
 *   the ledger retains no assistant-message text to scan for apology
 *   patterns query-time;
 * - rows stay keyed by RAW model identity (so model-vs-model quality/style
 *   comparison stays possible after an Alias) while the cost metric uses the
 *   seam's display (repriced) cost, so money reconciles with every other
 *   Section. The raw-identity deviation is grouping-only, never money.
 */
type ModelAcc = Omit<CompareModelStat, 'model' | 'displayName'>

function emptyAcc(): ModelAcc {
  return {
    calls: 0, costUSD: 0, outputTokens: 0, inputTokens: 0, cacheReadTokens: 0,
    totalTurns: 0, editTurns: 0, oneShotTurns: 0, retries: 0,
  }
}

/** Raw identity for Compare grouping: the provider-recorded model before any
 * Alias merge (`rawModel` when the seam merged, else the display model).
 * Quality/style metrics group by this; money still uses `costUSD` (display). */
function rawIdentity(call: { model: string; rawModel?: string }): string {
  return call.rawModel ?? call.model
}

function accumulateModelStats(sessions: SessionSummary[]): CompareModelStat[] {
  const byModel = new Map<string, ModelAcc>()

  const ensure = (model: string): ModelAcc => {
    let acc = byModel.get(model)
    if (!acc) {
      acc = emptyAcc()
      byModel.set(model, acc)
    }
    return acc
  }

  for (const session of sessions) {
    for (const turn of session.turns) {
      if (turn.assistantCalls.length === 0) continue
      // The turn's primary (first) call owns the turn-level figures; calls by
      // other models in the turn (subagents) still accrue their own call-level
      // stats.
      const primary = turn.assistantCalls[0]!
      const primaryRaw = rawIdentity(primary)
      if (primaryRaw === '<synthetic>') continue
      const primaryAcc = ensure(primaryRaw)
      primaryAcc.totalTurns++
      if (turn.hasEdits) {
        primaryAcc.editTurns++
        if (turn.retries === 0) primaryAcc.oneShotTurns++
      }
      primaryAcc.retries += turn.retries

      for (const call of turn.assistantCalls) {
        const raw = rawIdentity(call)
        if (raw === '<synthetic>') continue
        const acc = raw === primaryRaw ? primaryAcc : ensure(raw)
        acc.calls++
        acc.costUSD += call.costUSD
        acc.outputTokens += call.usage.outputTokens
        acc.inputTokens += call.usage.inputTokens
        acc.cacheReadTokens += call.usage.cacheReadInputTokens
      }
    }
  }

  return [...byModel.entries()]
    .map(([model, acc]) => ({ model, displayName: getShortModelName(model), ...acc }))
}

function pickWinner(valueA: number | null, valueB: number | null, higherIsBetter: boolean | null): CompareWinner {
  if (higherIsBetter === null || valueA === null || valueB === null) return 'none'
  if (valueA === valueB) return 'tie'
  if (higherIsBetter) return valueA > valueB ? 'a' : 'b'
  return valueA < valueB ? 'a' : 'b'
}

type MetricDef = {
  label: string
  formatFn: CompareFormatFn
  higherIsBetter: boolean | null
  compute: (s: CompareModelStat) => number | null
}

const METRICS: MetricDef[] = [
  { label: 'Calls', formatFn: 'number', higherIsBetter: null, compute: s => s.calls },
  { label: 'Total cost', formatFn: 'cost', higherIsBetter: null, compute: s => s.costUSD },
  { label: 'Input tokens', formatFn: 'compact', higherIsBetter: null, compute: s => s.inputTokens },
  { label: 'Output tokens', formatFn: 'compact', higherIsBetter: null, compute: s => s.outputTokens },
  {
    label: 'One-shot rate', formatFn: 'percent', higherIsBetter: true,
    compute: s => (s.editTurns > 0 ? (s.oneShotTurns / s.editTurns) * 100 : null),
  },
  {
    // Retries accumulate across ALL the model's primary turns
    // but are divided by edit turns ("retries per edit"), so the rate can
    // exceed 1.0 when a model also retries non-edit turns.
    label: 'Retry rate', formatFn: 'decimal', higherIsBetter: false,
    compute: s => (s.editTurns > 0 ? s.retries / s.editTurns : null),
  },
  {
    // No assistant-message text is retained to scan for apology
    // patterns, so this uses
    // the desktop's established selfCorrectionRate ratio (editTurns/totalTurns,
    // matching extractRatioMetrics). Lower is better.
    label: 'Self-correction rate', formatFn: 'percent', higherIsBetter: false,
    compute: s => (s.totalTurns > 0 ? (s.editTurns / s.totalTurns) * 100 : null),
  },
  {
    label: 'Cache hit rate', formatFn: 'percent', higherIsBetter: true,
    compute: s => {
      // Reads over reads + fresh input (excludes cache writes), matching the
      // rest of the app (extractRatioMetrics / Overview's cacheHitPercent).
      const total = s.inputTokens + s.cacheReadTokens
      return total > 0 ? (s.cacheReadTokens / total) * 100 : null
    },
  },
]

function computeComparison(a: CompareModelStat, b: CompareModelStat): ComparisonRow[] {
  return METRICS.map(metric => {
    const valueA = metric.compute(a)
    const valueB = metric.compute(b)
    return {
      label: metric.label,
      valueA,
      valueB,
      formatFn: metric.formatFn,
      winner: pickWinner(valueA, valueB, metric.higherIsBetter),
    }
  })
}

type CategoryAcc = { turns: number; editTurns: number; oneShotTurns: number }

function computeCategoryComparison(
  sessions: SessionSummary[],
  modelA: string,
  modelB: string,
): CategoryComparison[] {
  const mapA = new Map<string, CategoryAcc>()
  const mapB = new Map<string, CategoryAcc>()

  const ensure = (map: Map<string, CategoryAcc>, category: string): CategoryAcc => {
    let acc = map.get(category)
    if (!acc) {
      acc = { turns: 0, editTurns: 0, oneShotTurns: 0 }
      map.set(category, acc)
    }
    return acc
  }

  for (const session of sessions) {
    for (const turn of session.turns) {
      if (turn.assistantCalls.length === 0) continue
      const primary = rawIdentity(turn.assistantCalls[0]!)
      if (primary === '<synthetic>') continue
      if (primary !== modelA && primary !== modelB) continue

      const acc = ensure(primary === modelA ? mapA : mapB, turn.category)
      acc.turns++
      if (turn.hasEdits) {
        acc.editTurns++
        if (turn.retries === 0) acc.oneShotTurns++
      }
    }
  }

  const allCategories = new Set([...mapA.keys(), ...mapB.keys()])
  const result: CategoryComparison[] = []
  for (const category of allCategories) {
    const a = mapA.get(category)
    const b = mapB.get(category)
    if ((!a || a.editTurns === 0) && (!b || b.editTurns === 0)) continue

    result.push({
      category,
      turnsA: a?.turns ?? 0,
      editTurnsA: a?.editTurns ?? 0,
      oneShotRateA: a && a.editTurns > 0 ? (a.oneShotTurns / a.editTurns) * 100 : null,
      turnsB: b?.turns ?? 0,
      editTurnsB: b?.editTurns ?? 0,
      oneShotRateB: b && b.editTurns > 0 ? (b.oneShotTurns / b.editTurns) * 100 : null,
      winner: pickWinner(
        a && a.editTurns > 0 ? (a.oneShotTurns / a.editTurns) * 100 : null,
        b && b.editTurns > 0 ? (b.oneShotTurns / b.editTurns) * 100 : null,
        true,
      ),
    })
  }

  return result.sort((x, y) => (y.turnsA + y.turnsB) - (x.turnsA + x.turnsB))
}

const PLANNING_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite', 'EnterPlanMode', 'ExitPlanMode'])

function computeWorkingStyle(sessions: SessionSummary[], modelA: string, modelB: string): WorkingStyleRow[] {
  type StyleAcc = { totalTurns: number; agentSpawns: number; planModeUses: number; totalToolCalls: number; fastModeCalls: number }
  const sA: StyleAcc = { totalTurns: 0, agentSpawns: 0, planModeUses: 0, totalToolCalls: 0, fastModeCalls: 0 }
  const sB: StyleAcc = { totalTurns: 0, agentSpawns: 0, planModeUses: 0, totalToolCalls: 0, fastModeCalls: 0 }

  for (const session of sessions) {
    for (const turn of session.turns) {
      if (turn.assistantCalls.length === 0) continue
      const primary = rawIdentity(turn.assistantCalls[0]!)
      if (primary === '<synthetic>') continue
      if (primary !== modelA && primary !== modelB) continue

      const s = primary === modelA ? sA : sB
      s.totalTurns++
      const turnTools = turn.assistantCalls.flatMap(call => call.tools)
      if (turnTools.some(tool => PLANNING_TOOLS.has(tool)) || turn.assistantCalls.some(call => call.hasPlanMode)) {
        s.planModeUses++
      }
      for (const call of turn.assistantCalls) {
        s.totalToolCalls += call.tools.length
        if (call.hasAgentSpawn) s.agentSpawns++
        if (call.speed === 'fast') s.fastModeCalls++
      }
    }
  }

  const pct = (num: number, den: number): number | null => (den > 0 ? (num / den) * 100 : null)
  const avg = (num: number, den: number): number | null => (den > 0 ? num / den : null)

  return [
    { label: 'Delegation rate', valueA: pct(sA.agentSpawns, sA.totalTurns), valueB: pct(sB.agentSpawns, sB.totalTurns), formatFn: 'percent' },
    { label: 'Planning rate', valueA: pct(sA.planModeUses, sA.totalTurns), valueB: pct(sB.planModeUses, sB.totalTurns), formatFn: 'percent' },
    { label: 'Avg tools / turn', valueA: avg(sA.totalToolCalls, sA.totalTurns), valueB: avg(sB.totalToolCalls, sB.totalTurns), formatFn: 'decimal' },
    { label: 'Fast mode usage', valueA: pct(sA.fastModeCalls, sA.totalTurns), valueB: pct(sB.fastModeCalls, sB.totalTurns), formatFn: 'percent' },
  ]
}

/** Resolve the requested pair against the detected models: a valid distinct
 * pair wins, otherwise the default top-two by cost. */
function resolvePair(models: CompareModelStat[], pair: ComparePair | undefined): { a: CompareModelStat; b: CompareModelStat } {
  if (pair) {
    const a = models.find(model => model.model === pair.modelA)
    const b = models.find(model => model.model === pair.modelB)
    if (a && b && a !== b) return { a, b }
  }
  return { a: models[0]!, b: models[1]! }
}

/**
 * Ledger-backed Compare payload (map 05): the aggregation seam applies the
 * scope's range/provider at the SQL read and feeds the same pair-comparison
 * core (rows keyed by raw identity for quality/style comparison, cost
 * repriced through the seam's display cost).
 */
export function buildCompareViewFromLedger(
  store: LedgerStore,
  scope: OverviewScope,
  pair?: ComparePair,
  now = new Date(),
): ComparePayload {
  return comparePayloadSchema.parse(
    buildComparePayload(
      buildSessionSummaries(store, {
        range: overviewDateRange(scope, now),
        provider: scope.provider,
      }),
      pair,
    ),
  )
}

function buildComparePayload(sessions: SessionSummary[], pair?: ComparePair): ComparePayload {
  const models = accumulateModelStats(sessions)
    .sort((a, b) => (b.costUSD - a.costUSD) || a.model.localeCompare(b.model))

  if (models.length < 2) return { models, report: null }

  const { a, b } = resolvePair(models, pair)
  const reportBody: CompareReport = {
    modelA: a,
    modelB: b,
    metrics: computeComparison(a, b),
    categories: computeCategoryComparison(sessions, a.model, b.model),
    workingStyle: computeWorkingStyle(sessions, a.model, b.model),
  }
  return { models, report: reportBody }
}
