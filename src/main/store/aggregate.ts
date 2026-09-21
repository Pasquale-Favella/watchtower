import {
  calculateCost,
  createPricingConfigLookup,
  getShortModelName,
  type PricingConfigLookup,
} from '../pipeline/models.js'
import {
  buildSpawnPrSets,
  deriveCanonicalProjectKey,
  extractPrUrlsFromProviderCall,
  isAbsoluteProjectPath,
  projectNameFromPath,
} from '../pipeline/parser.js'
import { type SessionRow, sessionRowFromSummary } from '../pipeline/sessions-report.js'
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

/** Preload pricing/alias config once per scope read so per-row resolution is
 * a map hit. One shared lookup (also used by the Models lens) so every
 * Section resolves identical identities and rates. */
let pricingConfig: PricingConfigLookup = createPricingConfigLookup([], [])

function loadConfig(store: LedgerStore): void {
  pricingConfig = createPricingConfigLookup(store.getModelAliases(), store.getPriceOverrides())
}

/** The cost a call contributes to its session aggregate. Mirrors the Models
 * lens exactly (models-view `resolveCallCost`) so every Section reconciles:
 * a Price override on the EFFECTIVE (aliased) model wins; otherwise an
 * aliased call reprices through the normal pricing pipeline at its target's
 * rates; otherwise the scan's stored base cost stands. Override alone never
 * renames a model — identity comes from `pricingConfig.resolveAlias`, not from here.
 * Override names match verbatim first, then by normalized key (same spelling
 * tolerance as aliases). */
function resolveDisplayCost(call: LedgerCallRow, resolvedModel: string): number {
  const override = pricingConfig.findOverride(resolvedModel)
  if (override) {
    const input = call.inputTokens * (override.inputPricePerMillion / 1_000_000)
    const output = call.outputTokens * (override.outputPricePerMillion / 1_000_000)
    return Number.isFinite(input + output) ? input + output : call.baseCostUSD
  }
  if (resolvedModel !== call.model) {
    return calculateCost(
      resolvedModel,
      call.inputTokens,
      call.outputTokens,
      call.cacheCreationInputTokens,
      Math.max(call.cacheReadInputTokens, call.cachedInputTokens),
      call.webSearchRequests,
      call.speed,
    )
  }
  return call.baseCostUSD
}

/** Fixed-width `YYYY-…` UTC bounds: the only ISO shapes whose TEXT comparison
 * matches chronological order, so the only range bounds that may reach a
 * `WHERE timestamp` clause. */
const MIN_FILTERABLE_ISO = '1000-01-01T00:00:00.000Z'
const MAX_FILTERABLE_ISO = '9999-12-31T23:59:59.999Z'

/** True when a range bound formats as a fixed-width `YYYY-…` UTC instant, the
 * only shape whose TEXT comparison matches chronological order. The all-time
 * scopes (`views.ts` `ALL_TIME_RANGE` at ±8.64e15) format with `-271821` /
 * `+275760` year prefixes that sort outside every real row, so they must not
 * reach a `WHERE timestamp` clause — those scopes take the provider-only path
 * below instead. */
function isRangeFilterable(date: Date): boolean {
  const ms = date.getTime()
  if (!Number.isFinite(ms)) return false
  const iso = date.toISOString()
  return iso >= MIN_FILTERABLE_ISO && iso <= MAX_FILTERABLE_ISO
}

/** Price and alias every flat call for the scope (the per-row read seam). */
function resolveScopedCalls(rows: LedgerCallRow[]): ScopedCall[] {
  return rows.map(call => {
    const resolvedModel = pricingConfig.resolveAlias(call.model)
    return { ...call, resolvedModel, displayCostUSD: resolveDisplayCost(call, resolvedModel) }
  })
}

/** SQL read seam (#139): flat rows for the scope, provider- and range-filtered
 * in SQL, priced/aliased on read. Two phases: a range-filtered
 * `SELECT DISTINCT` over `ledger_call` discovers the sessions a view touches,
 * then those sessions' FULL history loads (pre-range turns stay for PR
 * seeding at the range start and for spawn-set attribution) while sessions
 * with no in-range calls never load at all — a 30-day view no longer reads
 * lifetime rows. All-time scopes skip the range prefilter (provider-only SQL
 * reads). The in-memory `turnInRange` gate in `assembleSession` stays the
 * exact filter either way, so both paths are byte-compatible with the old
 * full-scan read. */
export function queryScope(store: LedgerStore, scope: AggregateScope): LedgerScope {
  loadConfig(store)

  if (isRangeFilterable(scope.range.start) && isRangeFilterable(scope.range.end)) {
    const keys = store.getCallSessionKeysInRange(
      scope.range.start.toISOString(),
      scope.range.end.toISOString(),
      scope.provider,
    )
    return {
      sessions: store.getSessionsForKeys(keys, scope.provider),
      turns: store.getTurnsForSessionKeys(keys),
      calls: resolveScopedCalls(store.getCallsForSessionKeys(keys)),
    }
  }

  const allowedSources =
    scope.provider === undefined ? undefined : new Set(store.getSourceIdsForProvider(scope.provider))
  const keepSource = (sourceId: number): boolean => allowedSources === undefined || allowedSources.has(sourceId)
  return {
    sessions: store.getSessionsScoped().filter(s => keepSource(s.sourceId)),
    turns: store.getTurnsScoped().filter(t => keepSource(t.sourceId)),
    calls: resolveScopedCalls(store.getCallsScoped().filter(c => keepSource(c.sourceId))),
  }
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
      if (call.rawModel && call.rawModel !== call.model) {
        let set = provenance.get(modelKey)
        if (!set) {
          set = new Set<string>()
          provenance.set(modelKey, set)
        }
        set.add(call.rawModel)
      }

      for (const tool of call.tools.filter(t => !t.startsWith('mcp__'))) {
        const entry = toolBreakdown[tool] ?? { calls: 0 }
        entry.calls++
        toolBreakdown[tool] = entry
      }
      for (const mcp of call.mcpTools) {
        const server = mcp.split('__')[1] ?? mcp
        const entry = mcpBreakdown[server] ?? { calls: 0 }
        entry.calls++
        mcpBreakdown[server] = entry
      }
      for (const cmd of call.bashCommands) {
        const entry = bashBreakdown[cmd] ?? { calls: 0 }
        entry.calls++
        bashBreakdown[cmd] = entry
      }
      for (const sat of call.subagentTypes) {
        const entry = subagentBreakdown[sat] ?? { calls: 0, costUSD: 0, savingsUSD: 0 }
        entry.calls++
        entry.costUSD += call.costUSD
        entry.savingsUSD += callSavings
        subagentBreakdown[sat] = entry
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
    (canonicalPath ? projectNameFromPath(canonicalPath, summary.project) : summary.projectKey)
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
  const providerBySource = new Map<number, string>()
  for (const source of store.getSources()) {
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
    const assembled = assembleSession(session, turnsSorted, scope.range)
    if (!assembled) continue
    attachCanonicalIdentity(assembled, session, providerBySource.get(session.sourceId) ?? 'unknown')
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
    const first = list[0]
    if (first === undefined) throw new Error(`groupSummariesIntoProjects: empty group for key ${key}`)
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
