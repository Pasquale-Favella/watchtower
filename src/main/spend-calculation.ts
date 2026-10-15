import type { OverviewScope } from '../shared/schemas/overview.js'
import type {
  SpendDayEntry,
  SpendFlowLink,
  SpendFlowNode,
  SpendPayload,
  SpendSegment,
} from '../shared/schemas/spend.js'
import { localDateKey, overviewDateRange } from './overview-scope.js'
import { getShortModelName } from './pipeline/model-names.js'
import { resolveModelNameAlias } from './pipeline/pricing-calculation.js'
import type { SessionSummary } from './pipeline/types.js'
import { buildSessionSummariesFromSnapshotResult, sessionProjectKey } from './store/aggregate-calculation.js'
import type { LedgerQuerySnapshot } from './store/ledger-query-snapshot.js'

const SPEND_CHART_DAYS = 15
const TOP_NODE_LIMIT = 8
const OTHER_ID = '__other__'

type ScopedSession = { projectKey: string; project: string; session: SessionSummary }

function addToMap<K>(map: Map<K, number>, key: K, cost: number): void {
  map.set(key, (map.get(key) ?? 0) + cost)
}

function sortedEntries(totals: Map<string, number>): Array<[string, number]> {
  return [...totals.entries()].sort(([aName, aCost], [bName, bCost]) => bCost - aCost || aName.localeCompare(bName))
}

/** Daily bars merge checkouts by their displayed leaf; flow keeps canonical keys. */
function displayProjectSegments(segments: SpendSegment[], displayByKey: Map<string, string>): SpendSegment[] {
  const merged = new Map<string, number>()
  for (const segment of segments) {
    const display = displayByKey.get(segment.name) ?? segment.name
    merged.set(display, (merged.get(display) ?? 0) + segment.cost)
  }
  return [...merged.entries()]
    .map(([name, cost]) => ({ name, cost }))
    .sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name))
}

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
    out.push({ date: key, cost: segments.reduce((sum, segment) => sum + segment.cost, 0), segments })
    cursor.setDate(cursor.getDate() + 1)
  }
  return out
}

function earliestKey(...maps: Array<Map<string, unknown>>): string | null {
  let earliest: string | null = null
  for (const map of maps) for (const key of map.keys()) if (earliest === null || key < earliest) earliest = key
  return earliest
}

function rollLinks(
  matrix: Map<string, Map<string, number>>,
  keptModels: Set<string>,
  keptProjects: Set<string>,
): SpendFlowLink[] {
  const rolled = new Map<string, SpendFlowLink>()
  for (const [project, modelCosts] of matrix) {
    const rolledProject = keptProjects.has(project) ? project : OTHER_ID
    for (const [model, cost] of modelCosts) {
      const rolledModel = keptModels.has(model) ? model : OTHER_ID
      const key = `${rolledModel}\u0000${rolledProject}`
      const existing = rolled.get(key)
      if (existing) existing.cost += cost
      else rolled.set(key, { model: rolledModel, project: rolledProject, cost })
    }
  }
  return [...rolled.values()]
}

export type SpendCalculationResult = { value: SpendPayload; unpricedModels: readonly string[] }

/** Build Spend from one captured snapshot, scope, catalogue and clock value. */
export function calculateSpendView(
  snapshot: LedgerQuerySnapshot,
  scope: OverviewScope,
  now: Date,
): SpendCalculationResult {
  const aggregation = buildSessionSummariesFromSnapshotResult(snapshot, {
    range: overviewDateRange(scope, now),
    provider: scope.provider,
  })
  const scoped: ScopedSession[] = aggregation.summaries.map(session => ({
    projectKey: sessionProjectKey(session),
    project: session.project,
    session,
  }))
  const todayKey = localDateKey(now)
  const winEnd = scope.range?.until ?? todayKey
  const winStart =
    scope.range?.since ??
    localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (SPEND_CHART_DAYS - 1)))

  const byModelDay = new Map<string, Map<string, number>>()
  const byProjectDay = new Map<string, Map<string, number>>()
  const matrix = new Map<string, Map<string, number>>()
  const projectTotals = new Map<string, number>()
  const modelTotals = new Map<string, number>()
  const modelProvenance = new Map<string, Set<string>>()
  const projectDisplayByKey = new Map<string, string>()
  for (const { projectKey, project } of scoped)
    if (!projectDisplayByKey.has(projectKey)) projectDisplayByKey.set(projectKey, project)

  for (const { projectKey, session } of scoped) {
    for (const turn of session.turns) {
      for (const call of turn.assistantCalls) {
        const cost = call.costUSD
        if (!cost || cost <= 0) continue
        const model = getShortModelName(call.model, name => resolveModelNameAlias(snapshot.catalogue, name))
        if (model === '<synthetic>') continue
        if (call.rawModel && call.rawModel !== call.model) {
          let rawModels = modelProvenance.get(model)
          if (!rawModels) modelProvenance.set(model, (rawModels = new Set()))
          rawModels.add(call.rawModel)
        }

        let modelCosts = matrix.get(projectKey)
        if (!modelCosts) matrix.set(projectKey, (modelCosts = new Map()))
        addToMap(modelCosts, model, cost)
        addToMap(projectTotals, projectKey, cost)
        addToMap(modelTotals, model, cost)

        const ms = Date.parse(call.timestamp)
        if (Number.isNaN(ms)) continue
        const dayKey = localDateKey(new Date(ms))
        if (dayKey < winStart || dayKey > winEnd) continue
        let modelDay = byModelDay.get(dayKey)
        if (!modelDay) byModelDay.set(dayKey, (modelDay = new Map()))
        addToMap(modelDay, model, cost)
        let projectDay = byProjectDay.get(dayKey)
        if (!projectDay) byProjectDay.set(dayKey, (projectDay = new Map()))
        addToMap(projectDay, projectKey, cost)
      }
    }
  }

  const provenanceFor = (model: string): { sourceModels: string[] } | Record<string, never> => {
    const rawModels = modelProvenance.get(model)
    return rawModels?.size ? { sourceModels: [...rawModels].sort() } : {}
  }
  const byModel = contiguousDayEntries(byModelDay, winStart, winEnd).map(entry => ({
    ...entry,
    segments: entry.segments.map(segment => ({ ...segment, ...provenanceFor(segment.name) })),
  }))
  const byProject = contiguousDayEntries(byProjectDay, winStart, winEnd).map(entry => ({
    ...entry,
    segments: displayProjectSegments(entry.segments, projectDisplayByKey),
  }))
  const dataStart = earliestKey(byModelDay, byProjectDay)

  const { nodes: rawModels, keep: keptModels } = buildNodes(modelTotals)
  const models = rawModels.map(node => ({ ...node, ...provenanceFor(node.id) }))
  const { nodes: rawProjects, keep: keptProjects } = buildNodes(projectTotals)
  const projects = rawProjects.map(node => ({ ...node, label: projectDisplayByKey.get(node.id) ?? node.label }))
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
    value: { byModel, byProject, dataStart, flow: { models, projects, links } },
    unpricedModels: aggregation.unpricedModels,
  }
}
