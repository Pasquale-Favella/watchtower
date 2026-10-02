import { getShortModelName } from '../pipeline/model-names.js'
import {
  buildSpawnPrSets,
  deriveCanonicalProjectKey,
  extractPrUrlsFromProviderCall,
  isAbsoluteProjectPath,
  projectNameFromPath,
} from '../pipeline/parser-calculations.js'
import {
  calculateRepricedCostResult,
  type PricingCatalogue,
  type PricingConfigLookup,
  resolveModelNameAlias,
} from '../pipeline/pricing-calculation.js'
import { type SessionRow, sessionRowFromSummary } from '../pipeline/session-row.js'
import type {
  ClassifiedTurn,
  DateRange,
  ParsedApiCall,
  ProjectSummary,
  SessionSummary,
  TaskCategory,
  TokenUsage,
} from '../pipeline/types.js'
import type { LedgerSessionRow, LedgerTurnRow } from './ledger.js'
import type { LedgerQuerySnapshot } from './ledger-query-snapshot.js'
import type { LedgerCallFactsRow } from './read-projections.js'

/**
 * Query-time aggregation (ADR 0002). The ledger stores only transcript
 * facts; every view payload is re-derived here at read time from flat rows.
 * Pricing (price_override) and identity (model_alias) are pure config applied
 * per-row on read — never written back into scan rows, so a config change needs
 * no rescan. Nothing is materialized.
 */

/** Default window when a caller supplies no explicit range (30 days). */
export const DEFAULT_RANGE_DAYS = 30

/** A flat ledger call plus query-time pricing/identity resolution. The row is
 *  the seam's own `ledger_call` projection (`LedgerCallFactsRow`, 29 of the
 *  table's 38 columns) rather than the maximal `LedgerCallRow`: the nine
 *  omitted columns have no reader in `src/main`, and the per-column map with a
 *  `file:line` for every kept one is on `ledgerCallFactsRowSchema`
 *  (`./read-projections.ts`). `LedgerStore.getCalls` remains the wide read — the
 *  fallback, and the measurement harness's baseline. */
export type ScopedCall = LedgerCallFactsRow & {
  /** `model` after a configured `model_alias` rewrite (identity for display/grouping). */
  resolvedModel: string
  /** Query-time cost mirroring the Models lens: a Price override on the
   * effective model wins, else an aliased call reprices at its target's
   * rates, else the stored base cost stands. */
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

/** The cost a call contributes to its session aggregate. Mirrors the Models
 * lens exactly (models-view `resolveCallCost`) so every Section reconciles:
 * a Price override on the EFFECTIVE (aliased) model wins; otherwise an
 * aliased call reprices through the normal pricing pipeline at its target's
 * rates; otherwise the scan's stored base cost stands. Override alone never
 * renames a model — identity comes from `pricingConfig.resolveAlias`, not from here.
 * Override names match verbatim first, then by normalized key (same spelling
 * tolerance as aliases). */
function resolveDisplayCost(
  call: LedgerCallFactsRow,
  resolvedModel: string,
  pricingConfig: PricingConfigLookup,
  catalogue: PricingCatalogue,
): { cost: number; priced: boolean } {
  return calculateRepricedCostResult(catalogue, pricingConfig, {
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
}

/** Pure resolution result keeps unknown pricing visible to the outer boundary. */
export type LedgerScopeResult = { scope: LedgerScope; unpricedModels: readonly string[] }

export function queryScopeFromSnapshotResult(snapshot: LedgerQuerySnapshot, scope: AggregateScope): LedgerScopeResult {
  const providerBySource = new Map<number, string>()
  for (const source of snapshot.sources) providerBySource.set(source.id, source.provider)

  const providerFilter = scope.provider
  const keepSource = (sourceId: number): boolean => {
    if (!providerFilter) return true
    return providerBySource.get(sourceId) === providerFilter
  }

  const sessions = snapshot.sessions.filter(s => keepSource(s.sourceId))
  const turns = snapshot.turns.filter(t => keepSource(t.sourceId))
  const calls: ScopedCall[] = []
  const unpricedModels = new Set<string>()
  for (const call of snapshot.calls) {
    if (!keepSource(call.sourceId)) continue
    const resolvedModel = snapshot.pricing.resolveAlias(call.model)
    const displayCost = resolveDisplayCost(call, resolvedModel, snapshot.pricing, snapshot.catalogue)
    if (!displayCost.priced) unpricedModels.add(resolvedModel)
    calls.push({
      ...call,
      resolvedModel,
      displayCostUSD: displayCost.cost,
    })
  }

  return { scope: { sessions, turns, calls }, unpricedModels: [...unpricedModels] }
}

export function queryScopeFromSnapshot(snapshot: LedgerQuerySnapshot, scope: AggregateScope): LedgerScope {
  return queryScopeFromSnapshotResult(snapshot, scope).scope
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
    // The resolved (merged) model is the grouping/display identity in all
    // aggregated Sections; the raw model survives only via `rawModel` (Models
    // audit lens, Compare row identity, merged-row provenance).
    model: row.resolvedModel,
    usage,
    costUSD: row.displayCostUSD,
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
  if (row.resolvedModel !== row.model) call.rawModel = row.model
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
  const prRefs =
    row.prRefs.length > 0
      ? row.prRefs
      : extractPrUrlsFromProviderCall({
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
  modelShortName: (model: string) => string,
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
  // Provenance for merged rows: resolved short-name key -> raw model ids that
  // fed it via an alias. Only populated when a merge actually happened, so
  // unaliased sessions stay byte-identical to the old parser assembly.
  const provenance = new Map<string, Set<string>>()

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

    const cat = categoryBreakdown[turn.category] ?? {
      turns: 0,
      costUSD: 0,
      savingsUSD: 0,
      retries: 0,
      editTurns: 0,
      oneShotTurns: 0,
    }
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

      const modelKey = call.provider === 'devin' ? call.model : modelShortName(call.model)
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
      if (call.rawModel && call.rawModel !== call.model) {
        let set = provenance.get(modelKey)
        if (!set) {
          set = new Set<string>()
          provenance.set(modelKey, set)
        }
        set.add(call.rawModel)
      }

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

  for (const [key, raws] of provenance) {
    const bucket = modelBreakdown[key]
    if (bucket && raws.size > 0) bucket.sourceModels = [...raws].sort()
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
 * The grouping key for one session summary: the canonical project key when
 * the derivation ran, else the legacy project label. Project shells key on
 * this so one checkout is one shell; view payloads group by the summary's
 * display label (canonical leaf or orphan bucket, rewritten at the same
 * seam), which unifies the same spellings. Summaries assembled before the
 * derivation (fixtures, parser path) keep grouping exactly as before.
 */
export function sessionProjectKey(summary: SessionSummary): string {
  return summary.projectKey ?? summary.project
}

/**
 * Query-time canonical identity (#102): derive the grouping key and display
 * label from the stored path fields. `project_path` may hold the
 * discovery-dir fallback (a bare label, never an absolute path) when no
 * directory was ever known — only a native-absolute stored path counts as a
 * real checkout; anything else is a legacy label and the session belongs in
 * the per-provider orphan bucket (lossy slugs are never reparsed into paths).
 * Sessions with a canonical path display its leaf (original case); orphan
 * sessions display the bucket name, so every section — shells, rows, spend,
 * overview, compare, export — groups them into the visible bucket with no
 * per-view special cases.
 */
function attachCanonicalIdentity(summary: SessionSummary, session: LedgerSessionRow, provider: string): void {
  const storedPath = session.projectPath?.trim()
  const pathCandidate = storedPath && isAbsoluteProjectPath(storedPath) ? storedPath : undefined
  summary.projectKey = deriveCanonicalProjectKey(
    pathCandidate,
    session.workingDirectory,
    provider,
    session.canonicalCwd,
  )
  const canonicalPath = (session.canonicalCwd ?? session.workingDirectory ?? pathCandidate ?? '').trim()
  if (canonicalPath) {
    summary.projectPath = canonicalPath
  }
  // Display precedence: the explicit canonical project name first (Claude
  // worktrees — set from this same canonical path at parse time, so identical
  // for real data), then the path leaf in original case, then the legacy
  // label for orphans via the bucket name (set below).
  summary.project =
    session.canonicalProject ??
    (canonicalPath ? projectNameFromPath(summary.projectPath!, summary.project) : summary.projectKey)
}

/**
 * The aggregation seam: per-session aggregates for a scope, in range-slice order
 * (session_id asc), byte-compatible with what the parser's date-filtered rebuild
 * produced. Empty when the scope has no in-range data.
 */
export function buildSessionSummariesFromSnapshot(
  snapshot: LedgerQuerySnapshot,
  scope: AggregateScope,
): SessionSummary[] {
  return buildSessionSummariesFromSnapshotResult(snapshot, scope).summaries
}

export function buildSessionSummariesFromSnapshotResult(
  snapshot: LedgerQuerySnapshot,
  scope: AggregateScope,
): { summaries: SessionSummary[]; unpricedModels: readonly string[] } {
  const { scope: data, unpricedModels } = queryScopeFromSnapshotResult(snapshot, scope)

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
  const providerBySource = new Map<number, string>()
  for (const source of snapshot.sources) {
    providerBySource.set(source.id, source.provider)
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
    const assembled = assembleSession(session, turnsSorted, scope.range, model =>
      getShortModelName(model, name => resolveModelNameAlias(snapshot.catalogue, name)),
    )
    if (!assembled) continue
    attachCanonicalIdentity(assembled, session, providerBySource.get(session.sourceId) ?? 'unknown')
    const repoUrl = repoUrlBySource.get(session.sourceId)
    if (repoUrl) assembled.repoUrl = repoUrl
    out.push(assembled)
  }
  return { summaries: out.sort((a, b) => a.sessionId.localeCompare(b.sessionId)), unpricedModels }
}

/**
 * The Sessions-view payload: ledger-derived `SessionRow[]` for a scope,
 * byte-identical to the old `aggregateSessions` over the report. The scope's
 * range/provider filter already applied at the SQL read; each summary carries
 * its project label, so no ProjectSummary shell is reconstructed.
 */
export function buildSessionRowsFromSnapshot(snapshot: LedgerQuerySnapshot, scope: AggregateScope): SessionRow[] {
  return buildSessionSummariesFromSnapshot(snapshot, scope).map(summary =>
    sessionRowFromSummary(summary, summary.project),
  )
}

/**
 * Group the aggregation seam's session summaries into ProjectSummary shells for
 * consumers that still need the old project shape (export reassembly, the
 * Optimize/Yield detector cores). Shells key on the canonical project key so
 * one checkout is one project; orphan-bucket shells keep their explicit
 * `orphan:<provider>` name so unattributed spend stays visible.
 */
export function groupSummariesIntoProjects(sessions: SessionSummary[]): ProjectSummary[] {
  const byKey = new Map<string, SessionSummary[]>()
  for (const session of sessions) {
    const key = sessionProjectKey(session)
    const list = byKey.get(key)
    if (list) list.push(session)
    else byKey.set(key, [session])
  }
  return [...byKey.entries()].map(([key, list]) => {
    const first = list[0]!
    const canonicalPath = list.find(s => s.projectPath)?.projectPath
    // Shell display is the first member's seam-derived display (canonical
    // leaf, explicit canonical name, or orphan bucket) — the same label its
    // rows carry — so shells and rows never diverge. Pre-seam summaries
    // (parser path, fixtures) fall back to their legacy label untouched.
    return {
      project: key.startsWith('orphan:') ? key : first.project,
      projectPath: canonicalPath ?? list.find(s => s.workingDirectory)?.workingDirectory ?? first.project,
      totalCostUSD: list.reduce((sum, s) => sum + s.totalCostUSD, 0),
      totalSavingsUSD: list.reduce((sum, s) => sum + s.totalSavingsUSD, 0),
      totalEstimatedCostUSD: list.reduce((sum, s) => sum + (s.totalEstimatedCostUSD ?? 0), 0),
      totalApiCalls: list.reduce((sum, s) => sum + s.apiCalls, 0),
      totalProxiedCostUSD: 0,
      sessions: list,
      repoUrl: list.find(s => s.repoUrl)?.repoUrl,
    }
  })
}
