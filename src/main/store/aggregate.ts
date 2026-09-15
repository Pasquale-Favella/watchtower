import { getShortModelName } from '../pipeline/models.js'
import { buildSpawnPrSets, extractPrUrlsFromProviderCall } from '../pipeline/parser.js'
import { sessionRowFromSummary, type SessionRow } from '../pipeline/sessions-report.js'
import type {
  ClassifiedTurn,
  DateRange,
  ParsedApiCall,
  ProjectSummary,
  SessionSummary,
  TaskCategory,
  TokenUsage,
} from '../pipeline/types.js'
import type { LedgerCallRow, LedgerSessionRow, LedgerStore, LedgerTurnRow } from './ledger.js'

/**
 * Query-time aggregation (ADR 0002). The ledger stores only transcript
 * facts; every view payload is re-derived here at read time from flat rows.
 * Pricing (price_override) and identity (model_alias) are pure config applied
 * per-row on read — never written back into scan rows, so a config change needs
 * no rescan. Nothing is materialized.
 */

/** Default window when a caller supplies no explicit range (30 days). */
export const DEFAULT_RANGE_DAYS = 30

/** A flat ledger call plus query-time pricing/identity resolution. */
export type ScopedCall = LedgerCallRow & {
  /** `model` after a configured `model_alias` rewrite (identity for display/grouping). */
  resolvedModel: string
  /** Query-time cost: tokens × `price_override` when configured, else the stored base cost. */
  displayCostUSD: number
}

export interface LedgerScope {
  sessions: LedgerSessionRow[]
  turns: LedgerTurnRow[]
  calls: ScopedCall[]
}

export type AggregateScope = {
  range: DateRange
  /** Optional provider filter (matches `ledger_source.provider`). */
  provider?: string
}

export function defaultRange(end: Date = new Date(), days: number = DEFAULT_RANGE_DAYS): DateRange {
  const start = new Date(end.getTime() - days * 86_400_000)
  return { start, end }
}

const ALIASES = new Map<string, string>()
const OVERRIDES = new Map<string, { inputPerMillion: number; outputPerMillion: number }>()

/** Preload pricing/alias config once per scope read so per-row resolution is a map hit. */
function loadConfig(store: LedgerStore): void {
  ALIASES.clear()
  OVERRIDES.clear()
  for (const alias of store.getModelAliases()) ALIASES.set(alias.model, alias.aliasOf)
  for (const override of store.getPriceOverrides()) {
    OVERRIDES.set(override.model, {
      inputPerMillion: override.inputPricePerMillion,
      outputPerMillion: override.outputPricePerMillion,
    })
  }
}

function resolveModel(model: string): string {
  return ALIASES.get(model) ?? model
}

// Mirrors the pipeline's output-side pricing convention: Claude bills output
// tokens only; other providers fold reasoning tokens into the output bucket.
function outputTokensForCost(provider: string, outputTokens: number, reasoningTokens: number): number {
  return provider === 'claude' ? outputTokens : outputTokens + reasoningTokens
}

function resolveDisplayCost(call: LedgerCallRow): number {
  const override = OVERRIDES.get(call.model)
  if (!override) return call.baseCostUSD
  const input = call.inputTokens * (override.inputPerMillion / 1_000_000)
  const output = outputTokensForCost(call.provider, call.outputTokens, call.reasoningTokens) * (override.outputPerMillion / 1_000_000)
  return Number.isFinite(input + output) ? input + output : call.baseCostUSD
}

/** SQL read seam: flat rows for the scope, provider-filtered, priced/aliased on read. */
export function queryScope(store: LedgerStore, scope: AggregateScope): LedgerScope {
  loadConfig(store)

  const providerBySource = new Map<number, string>()
  for (const source of store.getSources()) providerBySource.set(source.id, source.provider)

  const providerFilter = scope.provider
  const keepSource = (sourceId: number): boolean => {
    if (!providerFilter) return true
    return providerBySource.get(sourceId) === providerFilter
  }

  const sessions = store.getSessions().filter(s => keepSource(s.sourceId))
  const turns = store.getTurns().filter(t => keepSource(t.sourceId))
  const calls: ScopedCall[] = []
  for (const call of store.getCalls()) {
    if (!keepSource(call.sourceId)) continue
    calls.push({ ...call, resolvedModel: resolveModel(call.model), displayCostUSD: resolveDisplayCost(call) })
  }

  return { sessions, turns, calls }
}

function turnInRange(firstCallTs: string | undefined, range: DateRange): boolean {
  if (!firstCallTs) return false
  const ts = new Date(firstCallTs).getTime()
  if (Number.isNaN(ts)) return false
  return ts >= range.start.getTime() && ts <= range.end.getTime()
}

function reconstructCall(row: ScopedCall): ParsedApiCall {
  const usage: TokenUsage = {
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheCreationInputTokens: row.cacheCreationInputTokens,
    cacheReadInputTokens: row.cacheReadInputTokens,
    cachedInputTokens: row.cachedInputTokens,
    reasoningTokens: row.reasoningTokens,
    webSearchRequests: row.webSearchRequests,
  }
  const call: ParsedApiCall = {
    provider: row.provider,
    model: row.model,
    usage,
    costUSD: row.baseCostUSD,
    tools: row.tools,
    mcpTools: row.mcpTools,
    skills: row.skills,
    subagentTypes: row.subagentTypes,
    hasAgentSpawn: row.tools.includes('Agent'),
    hasPlanMode: row.tools.includes('EnterPlanMode'),
    speed: row.speed,
    timestamp: row.timestamp,
    bashCommands: row.bashCommands,
    deduplicationKey: row.dedupKey ?? '',
    // The parser's call shape always carries these keys (explicitly undefined at
    // zero), so reconstruct them identically for byte-compatible assembly.
    isEstimated: row.isEstimated ? true : undefined,
    cacheCreationOneHourTokens: row.cacheCreationOneHourTokens > 0 ? row.cacheCreationOneHourTokens : undefined,
    toolSequence: row.toolSequence.length > 0 ? row.toolSequence : undefined,
  }
  if (row.savingsUSD > 0) {
    call.savingsUSD = row.savingsUSD
    call.savingsBaselineModel = row.savingsBaselineModel ?? undefined
    call.isLocalSavings = true
  }
  return call
}

function reconstructTurn(row: LedgerTurnRow, calls: ParsedApiCall[]): ClassifiedTurn {
  const turn: ClassifiedTurn = {
    userMessage: row.userMessage,
    assistantCalls: calls,
    timestamp: row.timestamp,
    sessionId: row.sessionId,
    category: row.category as TaskCategory,
    retries: row.retries,
    hasEdits: row.hasEdits === 1,
  }
  if (row.gitBranch) turn.gitBranch = row.gitBranch
  // Query-time fallback for ledger rows ported before PR capture (or under a
  // narrower URL shape): re-extract from the stored user message plus the
  // turn's executed commands, mirroring the parser's provider-call scan, so
  // already-ported sessions gain detection without a re-parse.
  const prRefs = row.prRefs.length > 0 ? row.prRefs : extractPrUrlsFromProviderCall({
    userMessage: row.userMessage,
    bashCommands: calls.flatMap(c => c.bashCommands ?? []),
    toolSequence: calls.flatMap(c => c.toolSequence ?? []),
  })
  if (prRefs.length > 0) turn.prRefs = prRefs
  if (row.spawnToolUseIds.length > 0) turn.spawnToolUseIds = row.spawnToolUseIds
  if (row.subCategory) turn.subCategory = row.subCategory
  return turn
}

// The PR set active entering a slice: the refs of the latest turn strictly before
// the slice start that referenced any PR. Mirrors the parser's
// recomputeRangeStartPrRefs (timestamp-selected, deterministic tie-break).
function recomputeRangeStartPrRefs(fullTurns: ClassifiedTurn[], sliceStartMs: number): string[] | undefined {
  let current: string[] | undefined
  let bestMs = -Infinity
  let bestKey = ''
  for (const turn of fullTurns) {
    if (!turn.prRefs?.length) continue
    const ts = turn.assistantCalls[0]?.timestamp
    if (!ts) continue
    const tMs = new Date(ts).getTime()
    if (Number.isNaN(tMs) || tMs >= sliceStartMs) continue
    const key = [...turn.prRefs].sort().join(',')
    if (tMs > bestMs || (tMs === bestMs && key > bestKey)) {
      bestMs = tMs
      bestKey = key
      current = turn.prRefs
    }
  }
  return current
}

function emptyTokens(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
  }
}

/**
 * Assemble one session's query-time facts from flat ledger rows (the hand-rolled
 * reducer for map 03 — byte-compatible with the old parser assembly, but computed
 * from the ledger and never rebuilding a ProjectSummary). `fullTurns` is the
 * session's ENTIRE turn list (needed for carry-forward and range-start seeding);
 * only in-range turns contribute to the aggregates, exactly like the parser's
 * date-sliced rebuild.
 */
export function assembleSession(
  session: LedgerSessionRow,
  fullTurns: ClassifiedTurn[],
  range: DateRange,
): SessionSummary | null {
  const inRange = fullTurns.filter(turn => turnInRange(turn.assistantCalls[0]?.timestamp, range))
  if (inRange.length === 0) return null

  const modelBreakdown: SessionSummary['modelBreakdown'] = {}
  const toolBreakdown: SessionSummary['toolBreakdown'] = {}
  const mcpBreakdown: SessionSummary['mcpBreakdown'] = {}
  const bashBreakdown: SessionSummary['bashBreakdown'] = {}
  const categoryBreakdown: SessionSummary['categoryBreakdown'] = {} as SessionSummary['categoryBreakdown']
  const skillBreakdown: SessionSummary['skillBreakdown'] = {}
  const subagentBreakdown: SessionSummary['subagentBreakdown'] = {}

  let totalCost = 0
  let totalSavings = 0
  let totalEstimated = 0
  let totalInput = 0
  let totalOutput = 0
  let totalReasoning = 0
  let totalCacheRead = 0
  let totalCacheWrite = 0
  let apiCalls = 0
  let firstTs = ''
  let lastTs = ''

  for (const turn of inRange) {
    const turnCost = turn.assistantCalls.reduce((s, c) => s + c.costUSD, 0)
    const turnSavings = turn.assistantCalls.reduce((s, c) => s + (c.savingsUSD ?? 0), 0)

    const cat = categoryBreakdown[turn.category] ?? { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 }
    categoryBreakdown[turn.category] = cat
    cat.turns++
    cat.costUSD += turnCost
    cat.savingsUSD += turnSavings
    if (turn.hasEdits) {
      cat.editTurns++
      cat.retries += turn.retries
      if (turn.retries === 0) cat.oneShotTurns++
    }

    if (turn.subCategory) {
      const skillKey = turn.subCategory
      if (!skillBreakdown[skillKey]) {
        skillBreakdown[skillKey] = { turns: 0, costUSD: 0, savingsUSD: 0, editTurns: 0, oneShotTurns: 0 }
      }
      const skill = skillBreakdown[skillKey]
      skill.turns++
      skill.costUSD += turnCost
      skill.savingsUSD += turnSavings
      if (turn.hasEdits) {
        skill.editTurns++
        if (turn.retries === 0) skill.oneShotTurns++
      }
    }

    for (const call of turn.assistantCalls) {
      const callSavings = call.savingsUSD ?? 0
      const callEstimated = call.isEstimated ? call.costUSD : 0
      totalCost += call.costUSD
      totalSavings += callSavings
      totalEstimated += callEstimated
      totalInput += call.usage.inputTokens
      totalOutput += call.usage.outputTokens
      totalReasoning += call.usage.reasoningTokens
      totalCacheRead += call.usage.cacheReadInputTokens
      totalCacheWrite += call.usage.cacheCreationInputTokens
      apiCalls++

      const modelKey = call.provider === 'devin' ? call.model : getShortModelName(call.model)
      if (!modelBreakdown[modelKey]) {
        modelBreakdown[modelKey] = {
          calls: 0,
          costUSD: 0,
          savingsUSD: 0,
          estimatedCostUSD: 0,
          tokens: emptyTokens(),
        }
      }
      const model = modelBreakdown[modelKey]
      model.calls++
      model.costUSD += call.costUSD
      model.savingsUSD += callSavings
      model.estimatedCostUSD = (model.estimatedCostUSD ?? 0) + callEstimated
      model.tokens.inputTokens += call.usage.inputTokens
      model.tokens.outputTokens += call.usage.outputTokens
      model.tokens.cacheReadInputTokens += call.usage.cacheReadInputTokens
      model.tokens.cacheCreationInputTokens += call.usage.cacheCreationInputTokens
      model.tokens.reasoningTokens += call.usage.reasoningTokens

      for (const tool of call.tools.filter(t => !t.startsWith('mcp__'))) {
        toolBreakdown[tool] = toolBreakdown[tool] ?? { calls: 0 }
        toolBreakdown[tool]!.calls++
      }
      for (const mcp of call.mcpTools) {
        const server = mcp.split('__')[1] ?? mcp
        mcpBreakdown[server] = mcpBreakdown[server] ?? { calls: 0 }
        mcpBreakdown[server]!.calls++
      }
      for (const cmd of call.bashCommands) {
        bashBreakdown[cmd] = bashBreakdown[cmd] ?? { calls: 0 }
        bashBreakdown[cmd]!.calls++
      }
      for (const sat of call.subagentTypes) {
        subagentBreakdown[sat] = subagentBreakdown[sat] ?? { calls: 0, costUSD: 0, savingsUSD: 0 }
        subagentBreakdown[sat]!.calls++
        subagentBreakdown[sat]!.costUSD += call.costUSD
        subagentBreakdown[sat]!.savingsUSD += callSavings
      }

      if (!firstTs || call.timestamp < firstTs) firstTs = call.timestamp
      if (!lastTs || call.timestamp > lastTs) lastTs = call.timestamp
    }
  }

  const summary: SessionSummary = {
    sessionId: session.sessionId,
    project: session.project ?? '',
    firstTimestamp: firstTs || inRange[0]?.timestamp || '',
    lastTimestamp: lastTs || inRange[inRange.length - 1]?.timestamp || '',
    totalCostUSD: totalCost,
    totalSavingsUSD: totalSavings,
    totalEstimatedCostUSD: totalEstimated,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalReasoningTokens: totalReasoning,
    totalCacheReadTokens: totalCacheRead,
    totalCacheWriteTokens: totalCacheWrite,
    apiCalls,
    turns: inRange,
    modelBreakdown,
    toolBreakdown,
    mcpBreakdown,
    bashBreakdown,
    categoryBreakdown,
    skillBreakdown,
    subagentBreakdown,
  }

  if (session.title) summary.title = session.title
  if (session.workingDirectory) summary.workingDirectory = session.workingDirectory
  if (session.agentType) summary.agentType = session.agentType
  if (session.parentSessionId) summary.parentSessionId = session.parentSessionId
  if (session.prLinks.length > 0) summary.prLinks = session.prLinks
  // Union in-range turn refs (including the query-time fallbacks above) into
  // the session links, mirroring the parser's observed-links union: a session
  // whose stored session links are empty but whose turns reference PRs still
  // counts as PR-linked instead of vanishing from the PR section.
  if (inRange.some(turn => turn.prRefs?.length)) {
    const observed = new Set(summary.prLinks ?? [])
    for (const turn of inRange) for (const ref of turn.prRefs ?? []) observed.add(ref)
    if (observed.size > 0) summary.prLinks = [...observed].sort()
  }
  if (Object.keys(session.agentSpawnLinks).length > 0) summary.agentSpawnLinks = session.agentSpawnLinks
  if (session.ambiguousSpawnAgentIds.length > 0) summary.ambiguousSpawnAgentIds = session.ambiguousSpawnAgentIds
  if (session.everHadBranch === 1) summary.everHadBranch = true
  if (session.mcpInventory.length > 0) summary.mcpInventory = session.mcpInventory

  const spawnPrSets = buildSpawnPrSets(fullTurns)
  if (Object.keys(spawnPrSets).length > 0) summary.spawnPrSets = spawnPrSets

  const rangeStart = recomputeRangeStartPrRefs(fullTurns, range.start.getTime())
  if (rangeStart?.length) summary.prRefsAtRangeStart = rangeStart

  return summary
}

/**
 * The aggregation seam: per-session aggregates for a scope, in range-slice order
 * (session_id asc), byte-compatible with what the parser's date-filtered rebuild
 * produced. Empty when the scope has no in-range data.
 */
export function buildSessionSummaries(store: LedgerStore, scope: AggregateScope): SessionSummary[] {
  const data = queryScope(store, scope)

  const sessionKey = (sourceId: number, sessionId: string): string => `${sourceId}\0${sessionId}`

  const callsByKey = new Map<string, ScopedCall[]>()
  for (const call of data.calls) {
    const key = `${sessionKey(call.sourceId, call.sessionId)}\0${call.turnIndex}`
    const list = callsByKey.get(key)
    if (list) list.push(call)
    else callsByKey.set(key, [call])
  }

  const turnsBySession = new Map<string, ClassifiedTurn[]>()
  for (const turn of data.turns) {
    const key = `${sessionKey(turn.sourceId, turn.sessionId)}\0${turn.turnIndex}`
    const calls = (callsByKey.get(key) ?? []).sort((a, b) => a.callIndex - b.callIndex)
    const list = turnsBySession.get(sessionKey(turn.sourceId, turn.sessionId)) ?? []
    list.push(reconstructTurn(turn, calls.map(reconstructCall)))
    turnsBySession.set(sessionKey(turn.sourceId, turn.sessionId), list)
  }

  const sessionsByKey = new Map<string, LedgerSessionRow>()
  for (const session of data.sessions) sessionsByKey.set(sessionKey(session.sourceId, session.sessionId), session)

  const repoUrlBySource = new Map<number, string>()
  for (const source of store.getSources()) {
    if (source.repoUrl) repoUrlBySource.set(source.id, source.repoUrl)
  }

  const out: SessionSummary[] = []
  for (const [key, turns] of turnsBySession) {
    const session = sessionsByKey.get(key)
    if (!session) continue
    const turnsSorted = turns.sort((a, b) => {
      const ta = new Date(a.assistantCalls[0]?.timestamp ?? a.timestamp).getTime()
      const tb = new Date(b.assistantCalls[0]?.timestamp ?? b.timestamp).getTime()
      return ta - tb || a.timestamp.localeCompare(b.timestamp)
    })
    const assembled = assembleSession(session, turnsSorted, scope.range)
    if (!assembled) continue
    const repoUrl = repoUrlBySource.get(session.sourceId)
    if (repoUrl) assembled.repoUrl = repoUrl
    out.push(assembled)
  }
  return out.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
}

/**
 * The Sessions-view payload: ledger-derived `SessionRow[]` for a scope,
 * byte-identical to the old `aggregateSessions` over the report. The scope's
 * range/provider filter already applied at the SQL read; each summary carries
 * its project label, so no ProjectSummary shell is reconstructed.
 */
export function buildSessionRows(store: LedgerStore, scope: AggregateScope): SessionRow[] {
  return buildSessionSummaries(store, scope).map(summary => sessionRowFromSummary(summary, summary.project))
}

/**
 * Group the aggregation seam's session summaries into ProjectSummary shells for
 * consumers that still need the old project shape (export reassembly, the
 * Optimize/Yield detector cores). `projectPath` degrades to the project label
 * because the seam summary carries the working directory but no canonical path;
 * the git-based yield path then falls back to its "not a work tree → no
 * commits" behavior for such sessions.
 */
export function groupSummariesIntoProjects(sessions: SessionSummary[]): ProjectSummary[] {
  const byProject = new Map<string, SessionSummary[]>()
  for (const session of sessions) {
    const list = byProject.get(session.project)
    if (list) list.push(session)
    else byProject.set(session.project, [session])
  }
  return [...byProject.entries()].map(([project, list]) => ({
    project,
    projectPath: list.find(s => s.workingDirectory)?.workingDirectory ?? project,
    totalCostUSD: list.reduce((sum, s) => sum + s.totalCostUSD, 0),
    totalSavingsUSD: list.reduce((sum, s) => sum + s.totalSavingsUSD, 0),
    totalEstimatedCostUSD: list.reduce((sum, s) => sum + (s.totalEstimatedCostUSD ?? 0), 0),
    totalApiCalls: list.reduce((sum, s) => sum + s.apiCalls, 0),
    totalProxiedCostUSD: 0,
    sessions: list,
    repoUrl: list.find(s => s.repoUrl)?.repoUrl,
  }))
}
