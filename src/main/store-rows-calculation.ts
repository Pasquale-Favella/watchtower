import type { ProjectRow, SessionRow } from '../shared/schemas/views.js'
import { canonicalSessionProject } from './canonical-session-project.js'
import { getShortModelName } from './pipeline/model-names.js'
import {
  calculateRepricedCostResult,
  createPricingConfigLookup,
  type PricingCatalogue,
  resolveModelNameAlias,
} from './pipeline/pricing-calculation.js'
import { providerFromModel } from './pipeline/session-row.js'
import type {
  SessionSummaryCall,
  SessionSummaryData,
  SessionSummarySession,
  SessionSummaryTurn,
} from './store/session-read-projections.js'

type GroupedCall = SessionSummaryCall & { resolvedModel: string; cost: number }
type AdmittedTurn = { row: SessionSummaryTurn; calls: GroupedCall[]; firstMs: number }
type CalculatedSession = {
  row: SessionRow
  projectKey: string
  projectPath?: string
  repoUrl?: string
}

const ALL_TIME_MIN = -8.64e15
const ALL_TIME_MAX = 8.64e15

function time(value: string): number {
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function key(sourceId: number, sessionId: string): string {
  return `${sourceId}\0${sessionId}`
}

function turnKey(sourceId: number, sessionId: string, turnIndex: number): string {
  return `${key(sourceId, sessionId)}\0${turnIndex}`
}

function calculateSessions(
  data: SessionSummaryData,
  catalogue: PricingCatalogue,
): {
  sessions: CalculatedSession[]
  unpricedModels: readonly string[]
} {
  const config = createPricingConfigLookup(data.aliases, data.overrides)
  const sessionsByKey = new Map<string, SessionSummarySession>()
  for (const session of data.sessions) sessionsByKey.set(key(session.sourceId, session.sessionId), session)

  const callsByTurn = new Map<string, GroupedCall[]>()
  const unpricedModels = new Set<string>()
  for (const call of data.calls) {
    const resolvedModel = config.resolveAlias(call.model)
    const priced = calculateRepricedCostResult(catalogue, config, {
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
    if (!priced.priced) unpricedModels.add(resolvedModel)
    const groupKey = turnKey(call.sourceId, call.sessionId, call.turnIndex)
    const calls = callsByTurn.get(groupKey) ?? []
    calls.push({ ...call, resolvedModel, cost: priced.cost })
    callsByTurn.set(groupKey, calls)
  }

  const turnsBySession = new Map<string, AdmittedTurn[]>()
  for (const turn of data.turns) {
    const calls = (callsByTurn.get(turnKey(turn.sourceId, turn.sessionId, turn.turnIndex)) ?? []).sort(
      (a, b) => a.callIndex - b.callIndex,
    )
    const firstCall = calls[0]
    if (!firstCall) continue
    const firstMs = time(firstCall.timestamp)
    // Legacy all-time filtering admits only turns whose first call has a finite
    // timestamp. A later malformed call remains part of the admitted turn.
    if (!Number.isFinite(firstMs) || firstMs < ALL_TIME_MIN || firstMs > ALL_TIME_MAX) continue
    const list = turnsBySession.get(key(turn.sourceId, turn.sessionId)) ?? []
    list.push({ row: turn, calls, firstMs })
    turnsBySession.set(key(turn.sourceId, turn.sessionId), list)
  }

  const output: CalculatedSession[] = []
  for (const [sessionKey, turns] of turnsBySession) {
    const session = sessionsByKey.get(sessionKey)
    if (!session) continue
    turns.sort((a, b) => a.firstMs - b.firstMs || a.row.timestamp.localeCompare(b.row.timestamp))

    let cost = 0
    let savingsUSD = 0
    let calls = 0
    let inputTokens = 0
    let outputTokens = 0
    let startedAt = ''
    let endedAt = ''
    const models: Record<string, true> = {}
    const provenance = new Map<string, Set<string>>()
    for (const turn of turns) {
      for (const call of turn.calls) {
        cost += call.cost
        // Ledger reconstitution drops zero and negative local savings.
        if (call.savingsUSD > 0) savingsUSD += call.savingsUSD
        calls++
        inputTokens += call.inputTokens
        outputTokens += call.outputTokens
        const displayModel =
          call.provider === 'devin'
            ? call.resolvedModel
            : getShortModelName(call.resolvedModel, name => resolveModelNameAlias(catalogue, name))
        models[displayModel] = true
        if (call.resolvedModel !== call.model) {
          const rawModels = provenance.get(displayModel) ?? new Set<string>()
          rawModels.add(call.model)
          provenance.set(displayModel, rawModels)
        }
        if (!startedAt || call.timestamp < startedAt) startedAt = call.timestamp
        if (!endedAt || call.timestamp > endedAt) endedAt = call.timestamp
      }
    }

    let provider = ''
    for (const turn of turns) {
      provider = turn.calls[0]?.provider ?? ''
      if (provider) break
    }
    if (!provider) provider = providerFromModel(Object.keys(models)[0] ?? '')
    const canonical = canonicalSessionProject(session, session.sourceProvider)
    const modelProvenance = Object.fromEntries(
      [...provenance.entries()].map(([model, raw]) => [model, [...raw].sort()]),
    )
    const row: SessionRow = {
      sessionId: session.sessionId,
      title: session.title ?? '',
      project: canonical.project,
      provider,
      models: Object.keys(models),
      ...(Object.keys(modelProvenance).length ? { modelProvenance } : {}),
      cost,
      savingsUSD,
      calls,
      turns: turns.length,
      inputTokens,
      outputTokens,
      startedAt,
      endedAt,
    }
    output.push({
      row,
      projectKey: canonical.projectKey,
      projectPath: canonical.projectPath,
      repoUrl: session.repoUrl || undefined,
    })
  }
  output.sort((a, b) => a.row.sessionId.localeCompare(b.row.sessionId))
  return { sessions: output, unpricedModels: [...unpricedModels] }
}

export function buildProjectRowsFromSessionData(
  data: SessionSummaryData,
  catalogue: PricingCatalogue,
): {
  rows: ProjectRow[]
  unpricedModels: readonly string[]
} {
  const result = calculateSessions(data, catalogue)
  const pathByPublicId = new Map<string, string>()
  for (const session of data.sessions) {
    if (!pathByPublicId.has(session.sessionId)) pathByPublicId.set(session.sessionId, session.projectPath ?? '')
  }
  const projects = new Map<string, ProjectRow>()
  for (const item of result.sessions) {
    let row = projects.get(item.projectKey)
    if (!row) {
      row = {
        project: item.row.project,
        projectPath: item.projectPath ?? pathByPublicId.get(item.row.sessionId) ?? '',
        cost: 0,
        calls: 0,
        sessions: 0,
        firstTimestamp: '',
        lastTimestamp: '',
      }
      projects.set(item.projectKey, row)
    }
    row.cost += item.row.cost
    row.calls += item.row.calls
    row.sessions++
    if (!row.firstTimestamp || item.row.startedAt < row.firstTimestamp) row.firstTimestamp = item.row.startedAt
    if (!row.lastTimestamp || item.row.endedAt > row.lastTimestamp) row.lastTimestamp = item.row.endedAt
    if (!row.repoUrl) row.repoUrl = item.repoUrl
  }
  return {
    rows: [...projects.values()].sort((a, b) => b.cost - a.cost),
    unpricedModels: result.unpricedModels,
  }
}

export function querySessionRowsFromSessionData(
  data: SessionSummaryData,
  catalogue: PricingCatalogue,
  filter: { project?: string; since?: string; until?: string },
): { rows: SessionRow[]; unpricedModels: readonly string[] } {
  const result = calculateSessions(data, catalogue)
  const sinceMs = filter.since ? new Date(filter.since).getTime() : Number.NEGATIVE_INFINITY
  const untilMs = filter.until ? new Date(filter.until).getTime() : Number.POSITIVE_INFINITY
  const rows = result.sessions
    .map(item => item.row)
    .filter(row => {
      if (filter.project && row.project !== filter.project) return false
      const started = time(row.startedAt)
      if (Number.isFinite(started) && started < sinceMs) return false
      if (Number.isFinite(started) && started > untilMs) return false
      return true
    })
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0))
  return { rows, unpricedModels: result.unpricedModels }
}
