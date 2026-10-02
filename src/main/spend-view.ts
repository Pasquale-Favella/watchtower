import * as Schema from 'effect/Schema'

import {
  type SpendDayEntry,
  type SpendFlow,
  type SpendFlowLink,
  type SpendFlowNode,
  type SpendPayload,
  spendPayloadSchema,
  type SpendSegment,
} from '../shared/schemas/spend.js'
import { localDateKey, overviewDateRange, type OverviewScope } from './overview.js'
import { getShortModelName } from './pipeline/models.js'
import type { SessionSummary } from './pipeline/types.js'
import { buildSessionSummaries, sessionProjectKey } from './store/aggregate.js'
import type { LedgerStore } from './store/ledger.js'

export type {
  SpendDayEntry,
  SpendFlow,
  SpendFlowLink,
  SpendFlowNode,
  SpendPayload,
  SpendSegment,
} from '../shared/schemas/spend.js'

const SPEND_CHART_DAYS = 15
const TOP_NODE_LIMIT = 8
const OTHER_ID = '__other__'

function addToMap<K>(map: Map<K, number>, key: K, cost: number): void {
  map.set(key, (map.get(key) ?? 0) + cost)
}

function sortedEntries(totals: Map<string, number>): Array<[string, number]> {
  return [...totals.entries()].sort(([aName, aCost], [bName, bCost]) => {
    const byCost = bCost - aCost
    return byCost !== 0 ? byCost : aName.localeCompare(bName)
  })
}

/** Map key-keyed day segments back to leaf display names. Same-leaf checkouts
 * sharing a day merge into one display segment (costs summed, no spend lost);
 * the Sankey flow below keeps them as separate key-id nodes. */
function displayProjectSegments(segments: SpendSegment[], displayByKey: Map<string, string>): SpendSegment[] {
  const merged = new Map<string, number>()
  for (const seg of segments) {
    const display = displayByKey.get(seg.name) ?? seg.name
    merged.set(display, (merged.get(display) ?? 0) + seg.cost)
  }
  return [...merged.entries()]
    .map(([name, cost]) => ({ name, cost }))
    .sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name))
}

/** The top `TOP_NODE_LIMIT`
 * nodes by cost plus an "Other" rollup node for the rest (when non-zero). */
function buildNodes(totals: Map<string, number>): { nodes: SpendFlowNode[]; keep: Set<string> } {
  const sorted = sortedEntries(totals)
  const top = sorted.slice(0, TOP_NODE_LIMIT)
  const rest = sorted.slice(TOP_NODE_LIMIT)
  const keep = new Set(top.map(([id]) => id))
  const nodes = top.map(([id, cost]) => ({ id, label: id, cost }))
  const otherCost = rest.reduce((sum, [, cost]) => sum + cost, 0)
  if (otherCost > 0) nodes.push({ id: OTHER_ID, label: 'Other', cost: otherCost })
  return { nodes, keep }
}

function contiguousDayEntries(
  byDay: Map<string, Map<string, number>>,
  fromKey: string,
  toKey: string,
): SpendDayEntry[] {
  if (fromKey > toKey) return []
  const [fy, fm, fd] = fromKey.split('-').map(Number)
  const [ty, tm, td] = toKey.split('-').map(Number)
  const cursor = new Date(fy, fm - 1, fd)
  const end = new Date(ty, tm - 1, td)
  const out: SpendDayEntry[] = []
  while (cursor <= end) {
    const key = localDateKey(cursor)
    const bucket = byDay.get(key)
    const segments: SpendSegment[] = bucket
      ? [...bucket.entries()]
          .map(([name, cost]) => ({ name, cost }))
          .sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name))
      : []
    out.push({ date: key, cost: segments.reduce((sum, seg) => sum + seg.cost, 0), segments })
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

function earliestKey(...maps: Array<Map<string, unknown>>): string | null {
  let earliest: string | null = null
  for (const map of maps) {
    for (const key of map.keys()) {
      if (earliest === null || key < earliest) earliest = key
    }
  }
  return earliest
}

/** Link rollup: models/projects that fell
 * out of the top list collapse onto the "__other__" node, then links are
 * ordered by model order then project order. */
function rollLinks(
  matrix: Map<string, Map<string, number>>,
  keptModels: Set<string>,
  keptProjects: Set<string>,
): SpendFlowLink[] {
  const rolled = new Map<string, SpendFlowLink>()
  for (const [project, modelCosts] of matrix.entries()) {
    const rolledProject = keptProjects.has(project) ? project : OTHER_ID
    for (const [model, cost] of modelCosts.entries()) {
      const rolledModel = keptModels.has(model) ? model : OTHER_ID
      const key = `${rolledModel}\u0000${rolledProject}`
      const existing = rolled.get(key)
      if (existing) existing.cost += cost
      else rolled.set(key, { model: rolledModel, project: rolledProject, cost })
    }
  }
  return [...rolled.values()]
}

/**
 * The Spend section's scoped payload (ADR 0008). Applies exactly the same
 * period / custom-range / provider scope as the Overview's `overview:query`,
 * mapped onto the aggregation seam (range + provider filters at the SQL read,
 * sessions count by their in-range turns), then:
 * - buckets each in-scope call by its local date into stacked daily segments
 *   by model and by project (a contiguous window: the custom range, or the
 *   last `SPEND_CHART_DAYS` days ending today);
 * - runs the `computeSpendFlow` aggregation (top-8 + "Other") over
 *   the full scoped set for the recharts-native Sankey.
 * Kept in the main process so the sandboxed renderer only receives
 * serializable rows over IPC.
 */
export function buildSpendViewFromLedger(store: LedgerStore, scope: OverviewScope, now = new Date()): SpendPayload {
  const scoped = buildSessionSummaries(store, { range: overviewDateRange(scope, now), provider: scope.provider })
    // Key spend buckets on the canonical project key so same-leaf checkouts
    // (/a/src, /b/src) never collapse; the leaf rides along for display only.
    .map(summary => ({ projectKey: sessionProjectKey(summary), project: summary.project, session: summary }))
  return Schema.decodeUnknownSync(spendPayloadSchema)(buildSpendPayload(scoped, scope, now))
}

function buildSpendPayload(
  scoped: Array<{ projectKey: string; project: string; session: SessionSummary }>,
  scope: OverviewScope,
  now: Date,
): SpendPayload {
  const todayKey = localDateKey(now)
  let winStart: string
  let winEnd: string
  if (scope.range) {
    winStart = scope.range.since
    winEnd = scope.range.until
  } else {
    winEnd = todayKey
    winStart = localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (SPEND_CHART_DAYS - 1)))
  }

  const byModelDay = new Map<string, Map<string, number>>()
  const byProjectDay = new Map<string, Map<string, number>>()
  const matrix = new Map<string, Map<string, number>>()
  const projectTotals = new Map<string, number>()
  const modelTotals = new Map<string, number>()
  const modelProvenance = new Map<string, Set<string>>()
  const projectDisplayByKey = new Map<string, string>()
  for (const { projectKey, project } of scoped) {
    if (!projectDisplayByKey.has(projectKey)) projectDisplayByKey.set(projectKey, project)
  }

  for (const { projectKey, session } of scoped) {
    for (const turn of session.turns) {
      for (const call of turn.assistantCalls) {
        const cost = call.costUSD
        if (!cost || cost <= 0) continue
        const model = getShortModelName(call.model)
        if (model === '<synthetic>') continue
        if (call.rawModel && call.rawModel !== call.model) {
          let set = modelProvenance.get(model)
          if (!set) {
            set = new Set<string>()
            modelProvenance.set(model, set)
          }
          set.add(call.rawModel)
        }

        let modelCosts = matrix.get(projectKey)
        if (!modelCosts) {
          modelCosts = new Map<string, number>()
          matrix.set(projectKey, modelCosts)
        }
        addToMap(modelCosts, model, cost)
        addToMap(projectTotals, projectKey, cost)
        addToMap(modelTotals, model, cost)

        const ms = Date.parse(call.timestamp)
        if (Number.isNaN(ms)) continue
        const dayKey = localDateKey(new Date(ms))
        if (dayKey < winStart || dayKey > winEnd) continue

        let modelDay = byModelDay.get(dayKey)
        if (!modelDay) {
          modelDay = new Map<string, number>()
          byModelDay.set(dayKey, modelDay)
        }
        addToMap(modelDay, model, cost)

        let projectDay = byProjectDay.get(dayKey)
        if (!projectDay) {
          projectDay = new Map<string, number>()
          byProjectDay.set(dayKey, projectDay)
        }
        addToMap(projectDay, projectKey, cost)
      }
    }
  }

  const provenanceFor = (model: string): { sourceModels: string[] } | Record<string, never> => {
    const raws = modelProvenance.get(model)
    return raws && raws.size > 0 ? { sourceModels: [...raws].sort() } : {}
  }
  const byModel = contiguousDayEntries(byModelDay, winStart, winEnd).map(entry => ({
    ...entry,
    segments: entry.segments.map(seg => ({ ...seg, ...provenanceFor(seg.name) })),
  }))
  const byProject = contiguousDayEntries(byProjectDay, winStart, winEnd).map(entry => ({
    ...entry,
    segments: displayProjectSegments(entry.segments, projectDisplayByKey),
  }))
  const dataStart = earliestKey(byModelDay, byProjectDay)

  const { nodes: rawModels, keep: keptModels } = buildNodes(modelTotals)
  const models = rawModels.map(node => ({ ...node, ...provenanceFor(node.id) }))
  const { nodes: rawProjects, keep: keptProjects } = buildNodes(projectTotals)
  // Flow node ids stay canonical keys (link-stable); labels show the leaf.
  // The "__other__" rollup node keeps its own label — it has no project key.
  const projects = rawProjects.map(node => ({
    ...node,
    label: projectDisplayByKey.get(node.id) ?? node.label,
  }))
  const modelOrder = new Map(models.map((node, index) => [node.id, index]))
  const projectOrder = new Map(projects.map((node, index) => [node.id, index]))
  const links = rollLinks(matrix, keptModels, keptProjects).sort((a, b) => {
    const byModel =
      (modelOrder.get(a.model) ?? Number.MAX_SAFE_INTEGER) - (modelOrder.get(b.model) ?? Number.MAX_SAFE_INTEGER)
    if (byModel !== 0) return byModel
    return (
      (projectOrder.get(a.project) ?? Number.MAX_SAFE_INTEGER) -
      (projectOrder.get(b.project) ?? Number.MAX_SAFE_INTEGER)
    )
  })

  return {
    byModel,
    byProject,
    dataStart,
    flow: { models, projects, links },
  }
}
