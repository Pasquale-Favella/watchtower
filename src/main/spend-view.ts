import { clampInt } from '../shared/lib/clamp.js'
import {
  type SpendDayEntry,
  type SpendFlowLink,
  type SpendFlowNode,
  type SpendPayload,
  spendPayloadSchema,
  type SpendSegment,
} from '../shared/schemas/spend.js'
import { localDateKey, overviewDateRange, type OverviewScope } from './overview.js'
import { getShortModelName } from './pipeline/models.js'
import {
  loadScopePricing,
  resolveScopedCalls,
  type ScopedCall,
  scopedSessionKeys,
  sessionProjectIdentity,
  turnInRange,
} from './store/aggregate.js'
import type { LedgerStore, SessionKey } from './store/ledger.js'

export type {
  SpendDayEntry,
  SpendFlow,
  SpendFlowLink,
  SpendFlowNode,
  SpendPayload,
  SpendSegment,
} from '../shared/schemas/spend.js'

const SPEND_CHART_DAYS = 15
const OTHER_ID = '__other__'

/** Top-N rollup size for the Spend flow (#139, `flowLimit`): how many
 * model/project nodes stay outside the "Other" rollup. Not offset paging —
 * the flow aggregates the full range-filtered scoped set, then keeps the top
 * N (default 8). Paging the Sankey inputs *before* aggregation is the #141
 * follow-up. Request-typed like the Sessions page (ADR 0008) — garbage
 * normalizes to the default instead of throwing. */
export interface SpendFlowPage {
  flowLimit?: unknown
}

export const SPEND_FLOW_DEFAULT_LIMIT = 8

export const SPEND_FLOW_MAX_LIMIT = 50

export function normalizeSpendFlowLimit(page: SpendFlowPage | undefined): number {
  return clampInt(page?.flowLimit, SPEND_FLOW_DEFAULT_LIMIT, 1, SPEND_FLOW_MAX_LIMIT)
}

function addToMap<K>(map: Map<K, number>, key: K, cost: number): void {
  map.set(key, (map.get(key) ?? 0) + cost)
}

function sortedEntries(totals: Map<string, number>): Array<[string, number]> {
  return [...totals.entries()].sort(([aName, aCost], [bName, bCost]) => {
    const byCost = bCost - aCost
    return byCost !== 0 ? byCost : aName.localeCompare(bName)
  })
}

/** The merged-row provenance for one short model name: the sorted raw model
 * ids that fed it via an alias, or an empty object when nothing merged. */
function provenanceOf(
  modelProvenance: Map<string, Set<string>>,
  model: string,
): { sourceModels: string[] } | Record<string, never> {
  const raws = modelProvenance.get(model)
  if (raws !== undefined && raws.size > 0) return { sourceModels: [...raws].sort() }
  return {}
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

/** The top `limit` nodes by cost plus an "Other" rollup node for the rest (when non-zero). */
function buildNodes(totals: Map<string, number>, limit: number): { nodes: SpendFlowNode[]; keep: Set<string> } {
  const sorted = sortedEntries(totals)
  const top = sorted.slice(0, limit)
  const rest = sorted.slice(limit)
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

/** Sessions per streamed chunk (#141 item 1): one chunk's sessions, turns,
 * and calls is the most that ever materializes during a Spend read. Chunks
 * are session-granular (a session's calls never split across chunks), so
 * chunking is byte-invisible by construction. Test seam: pass a smaller
 * `sessionChunkSize` to `buildSpendViewFromLedger` to prove chunk-invariance. */
export const SPEND_SESSION_CHUNK = 100

/** One spend-contributing call: its canonical project identity plus the
 * priced/model-resolved facts the accumulation needs. */
interface SpendFlatCall {
  projectKey: string
  project: string
  model: string
  rawModel: string | undefined
  costUSD: number
  timestamp: string
}

/** The running Sankey/chart accumulation (small maps — the only state that
 * survives across streamed chunks). */
interface SpendAccumulator {
  byModelDay: Map<string, Map<string, number>>
  byProjectDay: Map<string, Map<string, number>>
  matrix: Map<string, Map<string, number>>
  projectTotals: Map<string, number>
  modelTotals: Map<string, number>
  modelProvenance: Map<string, Set<string>>
  projectDisplayByKey: Map<string, string>
}

function createSpendAccumulator(): SpendAccumulator {
  return {
    byModelDay: new Map(),
    byProjectDay: new Map(),
    matrix: new Map(),
    projectTotals: new Map(),
    modelTotals: new Map(),
    modelProvenance: new Map(),
    projectDisplayByKey: new Map(),
  }
}

/** Folds one priced call into the accumulation: flow/matrix/totals see every
 * gated call, daily buckets only the in-window ones. Verbatim the old
 * per-call body (same skips, same provenance, same windowing). */
function accumulateSpendCall(acc: SpendAccumulator, call: SpendFlatCall, winStart: string, winEnd: string): void {
  const cost = call.costUSD
  if (!cost || cost <= 0) return
  const model = getShortModelName(call.model)
  if (model === '<synthetic>') return
  if (call.rawModel && call.rawModel !== call.model) {
    let set = acc.modelProvenance.get(model)
    if (!set) {
      set = new Set<string>()
      acc.modelProvenance.set(model, set)
    }
    set.add(call.rawModel)
  }

  let modelCosts = acc.matrix.get(call.projectKey)
  if (!modelCosts) {
    modelCosts = new Map<string, number>()
    acc.matrix.set(call.projectKey, modelCosts)
  }
  addToMap(modelCosts, model, cost)
  addToMap(acc.projectTotals, call.projectKey, cost)
  addToMap(acc.modelTotals, model, cost)

  const ms = Date.parse(call.timestamp)
  if (Number.isNaN(ms)) return
  const dayKey = localDateKey(new Date(ms))
  if (dayKey < winStart || dayKey > winEnd) return

  let modelDay = acc.byModelDay.get(dayKey)
  if (!modelDay) {
    modelDay = new Map<string, number>()
    acc.byModelDay.set(dayKey, modelDay)
  }
  addToMap(modelDay, model, cost)

  let projectDay = acc.byProjectDay.get(dayKey)
  if (!projectDay) {
    projectDay = new Map<string, number>()
    acc.byProjectDay.set(dayKey, projectDay)
  }
  addToMap(projectDay, call.projectKey, cost)
}

function chunkSessionKeys(keys: SessionKey[], size: number): SessionKey[][] {
  const out: SessionKey[][] = []
  for (let i = 0; i < keys.length; i += size) out.push(keys.slice(i, i + size))
  return out
}

const sessionKeyOf = (sourceId: number, sessionId: string): string => `${sourceId}\0${sessionId}`

/**
 * The Spend section's scoped payload (ADR 0008). Applies exactly the same
 * period / custom-range / provider scope as the Overview's `overview:query`,
 * mapped onto the aggregation seam (range + provider filters at the SQL read,
 * sessions count by their in-range turns), then:
 * - buckets each in-scope call by its local date into stacked daily segments
 *   by model and by project (a contiguous window: the custom range, or the
 *   last `SPEND_CHART_DAYS` days ending today);
 * - runs the `computeSpendFlow` aggregation (top-N + "Other", N from the
 *   flow page, default 8) over the range-filtered scoped set for the
 *   recharts-native Sankey. The Sankey inputs stream in session chunks
 *   (#141 item 1): only one chunk's rows materialize at a time, while the
 *   accumulation (small maps) is order-independent — byte-identical to the
 *   old full-set aggregation.
 * Kept in the main process so the sandboxed renderer only receives
 * serializable rows over IPC.
 */
export function buildSpendViewFromLedger(
  store: LedgerStore,
  scope: OverviewScope,
  now = new Date(),
  page?: SpendFlowPage,
  sessionChunkSize: number = SPEND_SESSION_CHUNK,
): SpendPayload {
  const range = overviewDateRange(scope, now)
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

  // Discovery order matches the summaries order (session_id asc) so the
  // project display map's first-wins behaves identically to the old path.
  // Key spend buckets on the canonical project key so same-leaf checkouts
  // (/a/src, /b/src) never collapse; the leaf rides along for display only.
  const keys = scopedSessionKeys(store, { range, provider: scope.provider }).sort((a, b) =>
    a.sessionId.localeCompare(b.sessionId),
  )
  loadScopePricing(store)
  const providerBySource = new Map<number, string>()
  for (const source of store.getSources()) providerBySource.set(source.id, source.provider)

  const acc = createSpendAccumulator()
  const chunkSize = Math.max(1, Math.floor(sessionChunkSize))
  for (const chunk of chunkSessionKeys(keys, chunkSize)) {
    const sessionsByKey = new Map(
      store.getSessionsForKeys(chunk, scope.provider).map(s => [sessionKeyOf(s.sourceId, s.sessionId), s]),
    )
    // Turn-row join parity with the summary assembly: calls whose turn row
    // is absent never reach a summary, so they never reach spend either.
    const turnKeys = new Set(
      store.getTurnsForSessionKeys(chunk).map(t => `${sessionKeyOf(t.sourceId, t.sessionId)}\0${t.turnIndex}`),
    )
    // Calls arrive ordered by session/turn/call and chunks are
    // session-granular (a session's calls never split across chunks): group
    // contiguous turns, gate each group on its first call (exactly
    // `assembleSession`'s `turnInRange`), and accumulate the survivors.
    let group: ScopedCall[] = []
    let groupKey = ''
    const flushGroup = (calls: ScopedCall[], key: string): void => {
      const first = calls[0]
      if (first === undefined || !turnKeys.has(key) || !turnInRange(first.timestamp, range)) return
      const session = sessionsByKey.get(sessionKeyOf(first.sourceId, first.sessionId))
      if (session === undefined) return
      const identity = sessionProjectIdentity(
        session,
        providerBySource.get(session.sourceId) ?? 'unknown',
        session.project ?? '',
      )
      if (!acc.projectDisplayByKey.has(identity.projectKey)) {
        acc.projectDisplayByKey.set(identity.projectKey, identity.project)
      }
      for (const call of calls) {
        accumulateSpendCall(
          acc,
          {
            projectKey: identity.projectKey,
            project: identity.project,
            model: call.resolvedModel,
            rawModel: call.resolvedModel !== call.model ? call.model : undefined,
            costUSD: call.displayCostUSD,
            timestamp: call.timestamp,
          },
          winStart,
          winEnd,
        )
      }
    }
    for (const call of resolveScopedCalls(store.getCallsForSessionKeys(chunk))) {
      const key = `${sessionKeyOf(call.sourceId, call.sessionId)}\0${call.turnIndex}`
      if (group.length > 0 && key !== groupKey) {
        flushGroup(group, groupKey)
        group = []
      }
      groupKey = key
      group.push(call)
    }
    flushGroup(group, groupKey)
  }

  return spendPayloadSchema.parse(buildSpendPayload(acc, scope, now, normalizeSpendFlowLimit(page)))
}

function buildSpendPayload(
  acc: SpendAccumulator,
  scope: OverviewScope,
  now: Date,
  flowLimit: number,
): SpendPayload {
  const { byModelDay, byProjectDay, matrix, projectTotals, modelTotals, modelProvenance, projectDisplayByKey } = acc
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

  const byModel = contiguousDayEntries(byModelDay, winStart, winEnd).map(entry => ({
    ...entry,
    segments: entry.segments.map(seg => ({ ...seg, ...provenanceOf(modelProvenance, seg.name) })),
  }))
  const byProject = contiguousDayEntries(byProjectDay, winStart, winEnd).map(entry => ({
    ...entry,
    segments: displayProjectSegments(entry.segments, projectDisplayByKey),
  }))
  const dataStart = earliestKey(byModelDay, byProjectDay)

  const { nodes: rawModels, keep: keptModels } = buildNodes(modelTotals, flowLimit)
  const models = rawModels.map(node => ({ ...node, ...provenanceOf(modelProvenance, node.id) }))
  const { nodes: rawProjects, keep: keptProjects } = buildNodes(projectTotals, flowLimit)
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
