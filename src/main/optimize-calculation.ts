import {
  type ContextBloatCandidate,
  type HealthGrade,
  type Impact,
  type LowWorthCandidate,
  type OptimizeFinding,
  type OptimizePayload,
  type Trend,
  type WasteAction,
} from '../shared/schemas/optimize.js'
import type { OverviewScope } from '../shared/schemas/overview.js'
import { scopeDateRange } from './overview-scope.js'
import type { DateRange, ProjectSummary, SessionSummary } from './pipeline/types.js'
import type { DeferralEnvHit, OptimizeSetup } from './setup-facts.js'

export type {
  ContextBloatCandidate,
  FindingId,
  HealthGrade,
  Impact,
  LowWorthCandidate,
  OptimizeFinding,
  OptimizePayload,
  PasteDestination,
  Trend,
  WasteAction,
} from '../shared/schemas/optimize.js'

/** Query-time Optimize diagnostics. Quantities describe observations or explicit
 * models; a pattern alone does not establish avoidable spend. */

// ============================================================================
// Token-estimation + threshold constants
// ============================================================================

const AVG_TOKENS_PER_READ = 600
const TOKENS_PER_MCP_TOOL = 400
const TOOLS_PER_MCP_SERVER = 5
const TOKENS_PER_AGENT_DEF = 80
const TOKENS_PER_SKILL_DEF = 80
const TOKENS_PER_COMMAND_DEF = 60

const MIN_JUNK_READS_TO_FLAG = 3
const JUNK_READS_HIGH_THRESHOLD = 20
const JUNK_READS_MEDIUM_THRESHOLD = 5
const MIN_DUPLICATE_READS_TO_FLAG = 5
const DUPLICATE_READS_HIGH_THRESHOLD = 30
const DUPLICATE_READS_MEDIUM_THRESHOLD = 10
const MIN_EDITS_FOR_RATIO = 10
const HEALTHY_READ_EDIT_RATIO = 4
const LOW_RATIO_HIGH_THRESHOLD = 2
const LOW_RATIO_MEDIUM_THRESHOLD = 3
const MIN_API_CALLS_FOR_CACHE = 10
const CACHE_EXCESS_HIGH_THRESHOLD = 15000
const UNUSED_MCP_HIGH_THRESHOLD = 3
const MCP_COVERAGE_MIN_TOOLS = 10
const MCP_COVERAGE_MIN_SESSIONS = 2
const MCP_COVERAGE_LOW_THRESHOLD = 0.2
const MCP_COVERAGE_HIGH_IMPACT_TOKENS = 200_000
const MCP_PROFILE_MIN_PROJECTS = 3
const MCP_PROFILE_MIN_HOT_INVOCATIONS = 2
const MCP_PROFILE_HOT_INVOCATION_SHARE = 0.8
const MCP_PROFILE_MIN_COLD_LOADED_SESSIONS = 2
const MCP_PROFILE_HIGH_IMPACT_TOKENS = 200_000
const MCP_PROFILE_PREVIEW = 3
const GHOST_AGENTS_HIGH_THRESHOLD = 5
const GHOST_AGENTS_MEDIUM_THRESHOLD = 2
const GHOST_SKILLS_HIGH_THRESHOLD = 10
const GHOST_SKILLS_MEDIUM_THRESHOLD = 5
const GHOST_COMMANDS_MEDIUM_THRESHOLD = 10
const MIN_SESSIONS_FOR_OUTLIER = 3
const YOUNG_PROJECT_SESSION_LIMIT = 2 * MIN_SESSIONS_FOR_OUTLIER
const SESSION_OUTLIER_MULTIPLIER = 2
const MIN_SESSION_OUTLIER_COST_USD = 1
const SESSION_OUTLIER_PREVIEW = 5
const CONTEXT_BLOAT_MIN_INPUT_TOKENS = 75_000
const CONTEXT_BLOAT_MIN_RATIO = 25
const CONTEXT_BLOAT_TARGET_RATIO = 15
const CONTEXT_BLOAT_PREVIEW = 5
const CONTEXT_BLOAT_LOW_INPUT_TOKENS = 200_000
const CONTEXT_BLOAT_HIGH_INPUT_TOKENS = 500_000
const CONTEXT_BLOAT_LOW_MAX_CANDIDATES = 2
const CONTEXT_BLOAT_HIGH_MIN_CANDIDATES = 10
const CONTEXT_BLOAT_GROWTH_RATIO = 2
const CONTEXT_BLOAT_GROWTH_MAX_GAP_MS = 7 * 24 * 60 * 60 * 1000
const CONTEXT_BLOAT_RATIO_DISPLAY_CAP = 1000
const WORTH_IT_MIN_COST_USD = 2
const WORTH_IT_NO_EDIT_MIN_COST_USD = 3
const WORTH_IT_MIN_RETRIES = 3
const WORTH_IT_RETRY_WITH_EDIT_MIN_RETRIES = 2
const WORTH_IT_PREVIEW = 5
const WORTH_IT_LOW_MAX_CANDIDATES = 2
const WORTH_IT_LOW_MAX_TOTAL_COST_USD = 10
const WORTH_IT_HIGH_MIN_CANDIDATES = 10
const WORTH_IT_HIGH_TOTAL_COST_USD = 50
const CAPABILITY_RELIABILITY_MIN_EDIT_TURNS = 5
const CAPABILITY_RELIABILITY_MIN_RETRY_TURNS = 3
const CAPABILITY_RELIABILITY_MIN_RETRY_RATE = 0.5
const CAPABILITY_RELIABILITY_PREVIEW = 5
const CAPABILITY_RELIABILITY_LOW_MAX_CANDIDATES = 1
const CAPABILITY_RELIABILITY_LOW_MAX_TOKENS = 50_000
const CAPABILITY_RELIABILITY_HIGH_MIN_CANDIDATES = 5
const CAPABILITY_RELIABILITY_HIGH_IMPACT_TOKENS = 200_000
const TOOL_SEARCH_TOOL_NAME = 'ToolSearch'
const ENABLE_TOOL_SEARCH_VAR = 'ENABLE_TOOL_SEARCH'
const ANTHROPIC_BASE_URL_VAR = 'ANTHROPIC_BASE_URL'
const CLAUDE_CODE_USE_VERTEX_VAR = 'CLAUDE_CODE_USE_VERTEX'
const FIRST_PARTY_API_HOST = 'api.anthropic.com'
const DEFERRAL_OFF_MIN_MCP_SESSIONS = 2
const DEFERRAL_OFF_HIGH_IMPACT_TOKENS = 200_000
const ALWAYSLOAD_MAX_CALLS_PER_SESSION = 0.2
const ALWAYSLOAD_HIGH_IMPACT_TOKENS = 200_000
const DEFER_THRESHOLD_CONTEXT_WINDOW_TOKENS = 200_000
const DEFER_THRESHOLD_DEFAULT_PERCENT = 10
const DEFER_THRESHOLD_MAX_PERCENT = 100
const DEFER_THRESHOLD_MIN_TOKENS_PER_SESSION = 5_000
const DEFER_THRESHOLD_MEDIUM_IMPACT_TOKENS = 200_000

const HEALTH_WEIGHT_HIGH = 15
const HEALTH_WEIGHT_MEDIUM = 7
const HEALTH_WEIGHT_LOW = 3
const HEALTH_MAX_PENALTY = 80
const GRADE_A_MIN = 90
const GRADE_B_MIN = 75
const GRADE_C_MIN = 55
const GRADE_D_MIN = 30
const URGENCY_IMPACT_WEIGHT = 0.5
const URGENCY_TOKEN_WEIGHT = 0.5
const URGENCY_TOKEN_NORMALIZE = 5_000_000
const URGENCY_WEIGHTS: Record<Impact, number> = { high: 1, medium: 0.5, low: 0.2 }

const RECENT_WINDOW_HOURS = 48
const RECENT_WINDOW_MS = RECENT_WINDOW_HOURS * 60 * 60 * 1000
const DEFAULT_TREND_PERIOD_DAYS = 30
const DEFAULT_TREND_PERIOD_MS = DEFAULT_TREND_PERIOD_DAYS * 24 * 60 * 60 * 1000
const IMPROVING_THRESHOLD = 0.5

const JUNK_DIRS = [
  'dist',
  'build',
  '__pycache__',
  '.next',
  '.nuxt',
  '.output',
  'coverage',
  '.cache',
  '.tsbuildinfo',
  '.svn',
  '.hg',
]
const JUNK_PATTERN = new RegExp(`/(?:${JUNK_DIRS.join('|')})/`)

const TOP_ITEMS_PREVIEW = 3
const GHOST_NAMES_PREVIEW = 5
const OPTIMIZE_TEXT_CAP = 500

const READ_TOOL_NAMES = new Set(['Read', 'Grep', 'Glob', 'FileReadTool', 'GrepTool', 'GlobTool'])
const EDIT_TOOL_NAMES = new Set(['Edit', 'FileEditTool', 'NotebookEdit'])

// ============================================================================
// Types
// ============================================================================

interface WasteFinding extends Pick<OptimizeFinding, 'id' | 'title' | 'explanation' | 'fix'> {
  impact: Impact
  trend?: Trend | null
  tokensSaved: number
  affectedSessionKeys?: Set<string>
  quantity?: OptimizeFinding['quantity']
}

/** Flattened tool-call view of the scoped sessions: each `toolSequence` step
 * with its normalized file path and a recency flag (flattened from the
 * ledger's toolSequence, not a JSONL scan). */
type ScanStep = {
  name: string
  filePath?: string
  sessionId: string
  sourceId?: number
  sessionKey?: string
  project: string
  recent: boolean
}

/** Per-call cache-creation event (version is empty
 * because the ledger does not persist the Claude Code version). */
type ApiCallMeta = {
  cacheCreationTokens: number
  version: string
  sessionKey?: string
  recent?: boolean
}

type McpServerCoverage = {
  server: string
  toolsAvailable: number
  toolsInvoked: number
  unusedTools: string[]
  invocations: number
  loadedSessions: number
  coverageRatio: number
}

type McpSchemaCostEstimate = {
  cacheWriteTokens: number
  cacheReadTokens: number
  effectiveInputTokens: number
}

type CapabilityKind = 'mcp' | 'skill'
type CapabilityRef = { kind: CapabilityKind; name: string }
type CapabilityReliabilityAccumulator = CapabilityRef & {
  editTurns: number
  retryTurns: number
  oneShotTurns: number
  retries: number
  tokensTouched: number
  projects: Set<string>
  retryTurnSavings: Map<string, number>
}

// ============================================================================
// Shared helpers
// ============================================================================

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '?'
  if (n < 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return Math.round(n).toString()
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/')
}

function fileBasename(p: string): string {
  const normalized = normalizeSlashes(p)
  return normalized.slice(normalized.lastIndexOf('/') + 1) || normalized
}

function shortHomePath(absPath: string, home: string): string {
  return absPath.startsWith(home) ? '~' + absPath.slice(home.length) : absPath
}

function isReadTool(name: string): boolean {
  return name === 'Read' || name === 'FileReadTool'
}

function isClaudeSession(session: SessionSummary): boolean {
  return session.turns.some(t => t.assistantCalls.some(c => c.provider === 'claude'))
}

function anySessionHasMcpInventory(projects: ProjectSummary[]): boolean {
  return projects.some(p => p.sessions.some(s => (s.mcpInventory?.length ?? 0) > 0))
}

function isEnvValueFalse(value: string): boolean {
  return value.toLowerCase() === 'false' || value === '0'
}

function isFirstPartyBaseUrl(value: string): boolean {
  try {
    return new URL(value).hostname === FIRST_PARTY_API_HOST
  } catch {
    return false
  }
}

function stepSessionKey(step: ScanStep): string {
  return step.sessionKey ?? `${step.sourceId ?? step.project}:${step.sessionId}`
}

// ============================================================================
// Scan-data collection (a store walk over the ledger, not a JSONL scan)
// ============================================================================

type ScanData = {
  steps: ScanStep[]
  cacheEvents: ApiCallMeta[]
  userMessages: string[]
  subagentTypes: Set<string>
  skills: Set<string>
}

function collectScanData(projects: ProjectSummary[], recentCutoffMs: number): ScanData {
  const steps: ScanStep[] = []
  const cacheEvents: ApiCallMeta[] = []
  const userMessages: string[] = []
  const subagentTypes = new Set<string>()
  const skills = new Set<string>()

  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        const msg = turn.userMessage?.trim()
        if (msg) userMessages.push(msg.slice(0, OPTIMIZE_TEXT_CAP))
        for (const call of turn.assistantCalls) {
          const recent = new Date(call.timestamp).getTime() >= recentCutoffMs
          if (call.usage.cacheCreationInputTokens > 0) {
            cacheEvents.push({
              cacheCreationTokens: call.usage.cacheCreationInputTokens,
              version: '',
              recent,
              sessionKey: sessionEvidenceKey(session),
            })
          }
          for (const sub of call.subagentTypes ?? []) if (sub) subagentTypes.add(sub)
          for (const skill of call.skills ?? []) if (skill.trim()) skills.add(skill.trim())
          for (const stepArr of call.toolSequence ?? []) {
            for (const step of stepArr) {
              steps.push({
                name: step.tool,
                filePath: step.file ? normalizeSlashes(step.file) : undefined,
                sessionId: session.sessionId,
                sourceId: session.sourceId,
                sessionKey: sessionEvidenceKey(session),
                project: project.project,
                recent,
              })
            }
          }
        }
      }
    }
  }

  return { steps, cacheEvents, userMessages, subagentTypes, skills }
}

// ============================================================================
// Read detectors
// ============================================================================

export function detectJunkReads(steps: ScanStep[], dateRange?: DateRange, now = new Date()): WasteFinding | null {
  const dirCounts = new Map<string, number>()
  let totalJunkReads = 0
  let recentJunkReads = 0
  const affectedSessionKeys = new Set<string>()

  for (const step of steps) {
    if (!isReadTool(step.name)) continue
    const filePath = step.filePath
    if (!filePath || /(?:^|\/)(?:AGENTS|SKILL)\.md$/i.test(filePath) || !JUNK_PATTERN.test(filePath)) continue
    totalJunkReads++
    affectedSessionKeys.add(stepSessionKey(step))
    if (step.recent) recentJunkReads++
    for (const dir of JUNK_DIRS) {
      if (filePath.includes(`/${dir}/`)) {
        dirCounts.set(dir, (dirCounts.get(dir) ?? 0) + 1)
        break
      }
    }
  }

  if (totalJunkReads < MIN_JUNK_READS_TO_FLAG) return null

  const hasRecentActivity = steps.some(s => s.recent)
  const trend = sessionTrend(recentJunkReads, totalJunkReads, dateRange, hasRecentActivity, now)
  if (trend === 'resolved') return null

  const sorted = [...dirCounts.entries()].sort((a, b) => b[1] - a[1])
  const dirList = sorted
    .slice(0, TOP_ITEMS_PREVIEW)
    .map(([d, n]) => `${d}/ (${n}x)`)
    .join(', ')
  const tokensSaved = totalJunkReads * AVG_TOKENS_PER_READ

  const detected = sorted.map(([d]) => d)
  const commonDefaults = ['node_modules', '.git', 'dist', '__pycache__']
  const extras = commonDefaults.filter(d => !dirCounts.has(d)).slice(0, Math.max(0, 6 - detected.length))
  const dirsToAvoid = [...detected, ...extras].join(', ')

  return {
    id: 'build-folder-reads',
    affectedSessionKeys,
    title: 'Review reads of generated folders',
    explanation: `Observed ${totalJunkReads} reads in commonly generated folders: ${dirList}. These reads can be necessary to investigate build behavior. Review their purpose before excluding files.`,
    impact:
      totalJunkReads > JUNK_READS_HIGH_THRESHOLD
        ? 'high'
        : totalJunkReads > JUNK_READS_MEDIUM_THRESHOLD
          ? 'medium'
          : 'low',
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'prompt',
      label: 'Review generated file access with your assistant:',
      text: `Before reading generated files under ${dirsToAvoid}, explain which evidence is needed and prefer source files when they answer the question.`,
    },
    trend,
  }
}

export function detectDuplicateReads(steps: ScanStep[], dateRange?: DateRange, now = new Date()): WasteFinding | null {
  const seenFiles = new Map<string, Set<string>>()
  const affectedSessionKeys = new Set<string>()
  let totalDuplicates = 0
  let recentDuplicates = 0
  const fileDupes = new Map<string, number>()

  for (const step of steps) {
    const file = step.filePath
    if (!file) continue
    const key = stepSessionKey(step)
    const seen = seenFiles.get(key) ?? new Set<string>()
    seenFiles.set(key, seen)
    if (EDIT_TOOL_NAMES.has(step.name) || step.name === 'Write' || step.name === 'FileWriteTool') {
      seen.delete(file)
      continue
    }
    if (!isReadTool(step.name) || JUNK_PATTERN.test(file)) continue
    if (seen.has(file)) {
      totalDuplicates++
      affectedSessionKeys.add(key)
      if (step.recent) recentDuplicates++
      const name = fileBasename(file)
      fileDupes.set(name, (fileDupes.get(name) ?? 0) + 1)
    }
    seen.add(file)
  }

  if (totalDuplicates < MIN_DUPLICATE_READS_TO_FLAG) return null

  const hasRecentActivity = steps.some(s => s.recent)
  const trend = sessionTrend(recentDuplicates, totalDuplicates, dateRange, hasRecentActivity, now)
  if (trend === 'resolved') return null

  const worst = [...fileDupes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_ITEMS_PREVIEW)
    .map(([name, n]) => `${name} (${n + 1}x)`)
    .join(', ')

  const tokensSaved = totalDuplicates * AVG_TOKENS_PER_READ

  return {
    id: 'redundant-rereads',
    affectedSessionKeys,
    title: 'Files read repeatedly without intervening edits',
    explanation: `${totalDuplicates} repeated reads within sessions without an intervening recorded edit. Top repeats: ${worst}. Search, partial reads, external changes and verification may justify rereads; file contents and read ranges are not captured.`,
    impact:
      totalDuplicates > DUPLICATE_READS_HIGH_THRESHOLD
        ? 'high'
        : totalDuplicates > DUPLICATE_READS_MEDIUM_THRESHOLD
          ? 'medium'
          : 'low',
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'prompt',
      label: 'Point your assistant at exact locations, for example:',
      text: 'In <file> lines <start>-<end>, look at the <function> function.',
    },
    trend,
  }
}

export function detectLowReadEditRatio(steps: ScanStep[]): WasteFinding | null {
  let reads = 0
  let edits = 0
  let recentEdits = 0
  let recentReads = 0
  const sessionCounts = new Map<string, { reads: number; edits: number }>()
  for (const step of steps) {
    const key = stepSessionKey(step)
    const counts = sessionCounts.get(key) ?? { reads: 0, edits: 0 }
    sessionCounts.set(key, counts)
    if (READ_TOOL_NAMES.has(step.name)) {
      reads++
      counts.reads++
      if (step.recent) recentReads++
    } else if (EDIT_TOOL_NAMES.has(step.name)) {
      edits++
      counts.edits++
      if (step.recent) recentEdits++
    }
  }

  if (edits < MIN_EDITS_FOR_RATIO) return null
  const ratio = reads / edits
  if (ratio >= HEALTHY_READ_EDIT_RATIO) return null

  const impact: Impact =
    ratio < LOW_RATIO_HIGH_THRESHOLD ? 'high' : ratio < LOW_RATIO_MEDIUM_THRESHOLD ? 'medium' : 'low'
  const tokensSaved = 0

  let trend: Trend | 'resolved' | null = null
  if (recentEdits >= MIN_EDITS_FOR_RATIO && edits - recentEdits >= MIN_EDITS_FOR_RATIO) {
    const recentRatio = recentReads / recentEdits
    const baselineRatio = (reads - recentReads) / (edits - recentEdits)
    if (recentRatio >= HEALTHY_READ_EDIT_RATIO) trend = 'resolved'
    else if (recentRatio > baselineRatio * (1 / IMPROVING_THRESHOLD)) trend = 'improving'
    else trend = 'active'
  }
  if (trend === 'resolved') return null

  return {
    id: 'read-edit-ratio',
    affectedSessionKeys: new Set(
      [...sessionCounts]
        .filter(([, c]) => c.edits > 0 && c.reads / c.edits < HEALTHY_READ_EDIT_RATIO)
        .map(([key]) => key),
    ),
    quantity: { value: ratio, unit: 'ratio' },
    title: 'Low recorded read-to-edit ratio',
    explanation: `Observed ${reads} reads/searches and ${edits} existing-file edits, a ratio of ${ratio.toFixed(1)}:1. New-file writes are excluded. The review threshold is ${HEALTHY_READ_EDIT_RATIO}:1; this does not establish a causal link to retries or an ideal ratio for every task.`,
    impact,
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'prompt',
      label: 'Discuss the file-reading approach with your assistant:',
      text: 'Before editing any file, read it first. Before modifying a function, grep for all callers. Research before you edit.',
    },
    trend,
  }
}

// ============================================================================
// Cache-warmup detector
// ============================================================================

const CACHE_BASELINE_QUANTILE = 0.25
const CACHE_BLOAT_MULTIPLIER = 1.4

function computeCacheBaseline(apiCalls: ApiCallMeta[]): number {
  const sorted = apiCalls
    .map(c => c.cacheCreationTokens)
    .filter(n => n > 0)
    .sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * CACHE_BASELINE_QUANTILE)] ?? 0
}

export function detectCacheBloat(
  apiCalls: ApiCallMeta[],
  _projects: ProjectSummary[],
  dateRange?: DateRange,
  now = new Date(),
): WasteFinding | null {
  if (apiCalls.length < MIN_API_CALLS_FOR_CACHE) return null

  const sorted = apiCalls.map(c => c.cacheCreationTokens).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const baseline = computeCacheBaseline(apiCalls)
  if (baseline <= 0) return null
  const bloatThreshold = baseline * CACHE_BLOAT_MULTIPLIER

  if (median < bloatThreshold) return null

  const recentCalls = apiCalls.filter(c => c.recent)
  const totalBloated = apiCalls.filter(c => c.cacheCreationTokens > bloatThreshold).length
  const recentBloated = recentCalls.filter(c => c.cacheCreationTokens > bloatThreshold).length
  const trend = sessionTrend(recentBloated, totalBloated, dateRange, recentCalls.length > 0, now)
  if (trend === 'resolved') return null

  // The desktop report does not persist the Claude Code version per call, so
  // the "Version X averages..." note is intentionally not emitted.
  const excess = median - baseline
  const tokensSaved = excess * apiCalls.length

  return {
    id: 'warmup-heavy',
    affectedSessionKeys: new Set(
      apiCalls.filter(c => c.cacheCreationTokens > bloatThreshold && c.sessionKey).map(c => c.sessionKey!),
    ),
    title: 'Cache writes vary substantially across calls',
    explanation: `Median cache creation per positive-write call is ${formatTokens(median)} tokens, ${formatTokens(excess)} above the lower-quartile baseline of ${formatTokens(baseline)} tokens per positive-write call. Different tasks and models can explain this variation; this is a peer diagnostic, not measured excess.`,
    impact: excess > CACHE_EXCESS_HIGH_THRESHOLD ? 'high' : 'medium',
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'prompt',
      label: 'Review cache-write variation:',
      text: 'Compare high cache-write calls with lower-write calls for task size, model, context changes and tool definitions. Check the installed provider documentation before changing cache settings.',
    },
    trend,
  }
}

// ============================================================================
// MCP coverage + profile detectors
// ============================================================================

export function aggregateMcpCoverage(projects: ProjectSummary[]): McpServerCoverage[] {
  type ServerAcc = {
    inventory: Set<string>
    invokedTools: Set<string>
    invocations: number
    loadedSessions: number
  }
  const servers = new Map<string, ServerAcc>()

  function getOrInit(server: string): ServerAcc {
    let acc = servers.get(server)
    if (!acc) {
      acc = { inventory: new Set(), invokedTools: new Set(), invocations: 0, loadedSessions: 0 }
      servers.set(server, acc)
    }
    return acc
  }

  for (const project of projects) {
    for (const session of project.sessions) {
      const inventoriedServers = new Set<string>()
      const sessionInvoked = new Map<string, Set<string>>()

      for (const fqn of session.mcpInventory ?? []) {
        const parts = fqn.split('__')
        if (parts.length < 3 || parts[0] !== 'mcp') continue
        const server = parts[1]
        if (!server) continue
        const tool = parts.slice(2).join('__')
        if (!tool) continue
        const acc = getOrInit(server)
        acc.inventory.add(fqn)
        inventoriedServers.add(server)
      }

      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          for (const fqn of call.mcpTools) {
            const parts = fqn.split('__')
            if (parts.length < 3 || parts[0] !== 'mcp') continue
            const server = parts[1]
            if (!server) continue
            let invoked = sessionInvoked.get(server)
            if (!invoked) {
              invoked = new Set()
              sessionInvoked.set(server, invoked)
            }
            invoked.add(fqn)
          }
        }
      }

      for (const [server, data] of Object.entries(session.mcpBreakdown)) {
        getOrInit(server).invocations += data.calls
      }
      for (const [server, invoked] of sessionInvoked) {
        const acc = getOrInit(server)
        for (const fqn of invoked) acc.invokedTools.add(fqn)
      }
      for (const server of inventoriedServers) {
        getOrInit(server).loadedSessions += 1
      }
    }
  }

  const result: McpServerCoverage[] = []
  for (const [server, acc] of servers) {
    if (acc.inventory.size === 0) continue
    const invokedInInventory = new Set<string>()
    for (const fqn of acc.invokedTools) {
      if (acc.inventory.has(fqn)) invokedInInventory.add(fqn)
    }
    const unusedTools = Array.from(acc.inventory)
      .filter(t => !invokedInInventory.has(t))
      .sort()
    const toolsInvoked = acc.inventory.size - unusedTools.length
    result.push({
      server,
      toolsAvailable: acc.inventory.size,
      toolsInvoked,
      unusedTools,
      invocations: acc.invocations,
      loadedSessions: acc.loadedSessions,
      coverageRatio: acc.inventory.size === 0 ? 0 : toolsInvoked / acc.inventory.size,
    })
  }
  result.sort((a, b) => b.toolsAvailable - a.toolsAvailable)
  return result
}

export function estimateMcpSchemaCost(
  unusedToolCountsByServer: Record<string, number>,
  projects: ProjectSummary[],
  servers: string[],
): McpSchemaCostEstimate {
  const totalUnusedSchemaTokens = servers.reduce(
    (s, srv) => s + (unusedToolCountsByServer[srv] ?? 0) * TOKENS_PER_MCP_TOOL,
    0,
  )
  if (totalUnusedSchemaTokens === 0) {
    return { cacheWriteTokens: 0, cacheReadTokens: 0, effectiveInputTokens: 0 }
  }

  const serverSet = new Set(servers)
  let cacheWriteTokens = 0
  let cacheReadTokens = 0

  for (const project of projects) {
    for (const session of project.sessions) {
      const loadedServers = new Set<string>()
      for (const fqn of session.mcpInventory ?? []) {
        const server = fqn.split('__')[1]
        if (server && serverSet.has(server)) loadedServers.add(server)
      }
      const sessionSchemaTokens = [...loadedServers].reduce(
        (sum, server) => sum + (unusedToolCountsByServer[server] ?? 0) * TOKENS_PER_MCP_TOOL,
        0,
      )
      if (sessionSchemaTokens === 0) continue

      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          if (call.usage.cacheCreationInputTokens > 0) {
            cacheWriteTokens += Math.min(sessionSchemaTokens, call.usage.cacheCreationInputTokens)
          }
          if (call.usage.cacheReadInputTokens > 0) {
            cacheReadTokens += Math.min(sessionSchemaTokens, call.usage.cacheReadInputTokens)
          }
        }
      }
    }
  }

  const effectiveInputTokens = cacheWriteTokens + cacheReadTokens
  return { cacheWriteTokens, cacheReadTokens, effectiveInputTokens }
}

export function detectMcpToolCoverage(
  projects: ProjectSummary[],
  coverage = aggregateMcpCoverage(projects),
): WasteFinding | null {
  if (coverage.length === 0) return null

  const flagged = coverage.filter(
    c =>
      c.toolsAvailable > MCP_COVERAGE_MIN_TOOLS &&
      c.loadedSessions >= MCP_COVERAGE_MIN_SESSIONS &&
      c.coverageRatio < MCP_COVERAGE_LOW_THRESHOLD,
  )
  if (flagged.length === 0) return null

  flagged.sort((a, b) => b.toolsAvailable - b.toolsInvoked - (a.toolsAvailable - a.toolsInvoked))

  const lines: string[] = []
  const unusedCountsByServer: Record<string, number> = {}
  const flaggedServers: string[] = []

  for (const c of flagged) {
    unusedCountsByServer[c.server] = c.toolsAvailable - c.toolsInvoked
    flaggedServers.push(c.server)
    const pct = Math.round(c.coverageRatio * 100)
    lines.push(
      `${c.server}: ${c.toolsInvoked}/${c.toolsAvailable} tools used (${pct}% coverage) across ${c.loadedSessions} session${c.loadedSessions === 1 ? '' : 's'}`,
    )
  }

  const cost = estimateMcpSchemaCost(unusedCountsByServer, projects, flaggedServers)
  const tokensSaved = Math.round(cost.effectiveInputTokens)
  const impact: Impact =
    tokensSaved >= MCP_COVERAGE_HIGH_IMPACT_TOKENS
      ? 'high'
      : flagged.length >= UNUSED_MCP_HIGH_THRESHOLD
        ? 'high'
        : 'medium'

  return {
    id: 'mcp-low-coverage',
    affectedSessionKeys: new Set(
      projects
        .flatMap(p => p.sessions)
        .filter(s => flaggedServers.some(server => sessionLoadedMcpServer(s, server)))
        .map(sessionEvidenceKey),
    ),
    title: `${flagged.length} MCP server${flagged.length === 1 ? '' : 's'} with low tool coverage`,
    explanation:
      `Observed tool inventories include tools without recorded invocations. Inventory does not prove full prompt exposure. ` +
      `${lines.join('; ')}.`,
    impact,
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'prompt',
      label: 'Review MCP tool exposure before changing configuration:',
      text: `Review ${flaggedServers.join(', ')} for project needs, discovery behavior and tool permissions. Consider project scoping or tool filtering only after checking which workflows depend on each server.`,
    },
  }
}

type McpProjectProfileStats = {
  project: string
  projectKey: string
  projectPath: string
  loadedSessions: number
  invocations: number
}

type McpProfileCandidate = {
  server: string
  toolsAvailable: number
  hotProjects: McpProjectProfileStats[]
  coldProjects: McpProjectProfileStats[]
  coldProjectKeys: Set<string>
  loadedProjects: number
  loadedSessions: number
  invocations: number
  hotShare: number
  estimatedTokensSaved: number
}

function projectProfileLabel(project: ProjectSummary): string {
  return project.projectPath || project.project
}

function projectProfileKey(project: ProjectSummary): string {
  return projectProfileLabel(project)
}

function sessionLoadedMcpServer(session: SessionSummary, server: string): boolean {
  for (const fqn of session.mcpInventory ?? []) {
    const parts = fqn.split('__')
    if (parts.length >= 3 && parts[0] === 'mcp' && parts[1] === server) return true
  }
  return false
}

function lowCoverageMcpServers(coverage: McpServerCoverage[]): Set<string> {
  return new Set(
    coverage
      .filter(
        c =>
          c.toolsAvailable > MCP_COVERAGE_MIN_TOOLS &&
          c.loadedSessions >= MCP_COVERAGE_MIN_SESSIONS &&
          c.coverageRatio < MCP_COVERAGE_LOW_THRESHOLD,
      )
      .map(c => c.server),
  )
}

function estimateMcpProfileColdSchemaCost(
  projects: ProjectSummary[],
  serverToolCounts: Map<string, number>,
  coldProjectKeysByServer: Map<string, Set<string>>,
): McpSchemaCostEstimate {
  if (serverToolCounts.size === 0 || coldProjectKeysByServer.size === 0) {
    return { cacheWriteTokens: 0, cacheReadTokens: 0, effectiveInputTokens: 0 }
  }

  let cacheWriteTokens = 0
  let cacheReadTokens = 0
  for (const project of projects) {
    const projectKey = projectProfileKey(project)
    for (const session of project.sessions) {
      let schemaTokens = 0
      for (const [server, toolsAvailable] of serverToolCounts) {
        if (!coldProjectKeysByServer.get(server)?.has(projectKey)) continue
        if (!sessionLoadedMcpServer(session, server)) continue
        schemaTokens += toolsAvailable * TOKENS_PER_MCP_TOOL
      }
      if (schemaTokens === 0) continue

      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          if (call.usage.cacheCreationInputTokens > 0) {
            cacheWriteTokens += Math.min(schemaTokens, call.usage.cacheCreationInputTokens)
          }
          if (call.usage.cacheReadInputTokens > 0) {
            cacheReadTokens += Math.min(schemaTokens, call.usage.cacheReadInputTokens)
          }
        }
      }
    }
  }

  const effectiveInputTokens = cacheWriteTokens + cacheReadTokens
  return { cacheWriteTokens, cacheReadTokens, effectiveInputTokens }
}

function collectMcpProjectProfiles(projects: ProjectSummary[], coverage: McpServerCoverage[]): McpProfileCandidate[] {
  const suppressedServers = lowCoverageMcpServers(coverage)
  const coverageByServer = new Map(coverage.map(c => [c.server, c]))
  const byServer = new Map<string, Map<string, McpProjectProfileStats>>()

  function getProjectStats(server: string, project: ProjectSummary): McpProjectProfileStats {
    let serverProjects = byServer.get(server)
    if (!serverProjects) {
      serverProjects = new Map()
      byServer.set(server, serverProjects)
    }
    const key = projectProfileKey(project)
    let stats = serverProjects.get(key)
    if (!stats) {
      stats = {
        project: project.project,
        projectKey: key,
        projectPath: projectProfileLabel(project),
        loadedSessions: 0,
        invocations: 0,
      }
      serverProjects.set(key, stats)
    }
    return stats
  }

  for (const project of projects) {
    for (const session of project.sessions) {
      const loadedServers = new Set<string>()
      for (const fqn of session.mcpInventory ?? []) {
        const parts = fqn.split('__')
        if (parts.length >= 3 && parts[0] === 'mcp' && parts[1]) loadedServers.add(parts[1])
      }
      for (const server of loadedServers) {
        getProjectStats(server, project).loadedSessions++
      }
      for (const [server, data] of Object.entries(session.mcpBreakdown)) {
        getProjectStats(server, project).invocations += data.calls
      }
    }
  }

  const candidates: McpProfileCandidate[] = []
  for (const [server, projectStats] of byServer) {
    if (suppressedServers.has(server)) continue
    const coverageStats = coverageByServer.get(server)
    if (!coverageStats) continue
    if (coverageStats.toolsAvailable === 0) continue

    const loaded = Array.from(projectStats.values()).filter(p => p.loadedSessions > 0)
    if (loaded.length < MCP_PROFILE_MIN_PROJECTS) continue
    const invocations = loaded.reduce((sum, p) => sum + p.invocations, 0)
    if (invocations < MCP_PROFILE_MIN_HOT_INVOCATIONS) continue

    loaded.sort(
      (a, b) =>
        b.invocations - a.invocations ||
        b.loadedSessions - a.loadedSessions ||
        a.projectPath.localeCompare(b.projectPath),
    )
    const invokedProjects = loaded.filter(p => p.invocations > 0)
    if (invokedProjects.length === 0) continue
    const hotProjects = invokedProjects.slice(0, 2)
    const hotInvocations = hotProjects.reduce((sum, p) => sum + p.invocations, 0)
    const hotShare = hotInvocations / invocations
    if (hotShare < MCP_PROFILE_HOT_INVOCATION_SHARE) continue

    const coldProjects = loaded.filter(p => p.invocations === 0)
    const coldLoadedSessions = coldProjects.reduce((sum, p) => sum + p.loadedSessions, 0)
    if (coldLoadedSessions < MCP_PROFILE_MIN_COLD_LOADED_SESSIONS) continue

    const coldProjectKeys = new Set(coldProjects.map(project => project.projectKey))
    const cost = estimateMcpProfileColdSchemaCost(
      projects,
      new Map([[server, coverageStats.toolsAvailable]]),
      new Map([[server, coldProjectKeys]]),
    )

    candidates.push({
      server,
      toolsAvailable: coverageStats.toolsAvailable,
      hotProjects,
      coldProjects,
      coldProjectKeys,
      loadedProjects: loaded.length,
      loadedSessions: loaded.reduce((sum, p) => sum + p.loadedSessions, 0),
      invocations,
      hotShare,
      estimatedTokensSaved: Math.round(cost.effectiveInputTokens),
    })
  }

  candidates.sort(
    (a, b) =>
      b.estimatedTokensSaved - a.estimatedTokensSaved ||
      b.coldProjects.length - a.coldProjects.length ||
      b.loadedSessions - a.loadedSessions ||
      a.server.localeCompare(b.server),
  )
  return candidates
}

export function detectMcpProfileAdvisor(
  projects: ProjectSummary[],
  coverage = aggregateMcpCoverage(projects),
): WasteFinding | null {
  const candidates = collectMcpProjectProfiles(projects, coverage)
  if (candidates.length === 0) return null

  const preview = candidates.slice(0, MCP_PROFILE_PREVIEW)
  const lines = preview.map(candidate => {
    const hot = candidate.hotProjects
      .slice(0, 2)
      .map(p => `${p.projectPath} (${p.invocations} call${p.invocations === 1 ? '' : 's'})`)
      .join(', ')
    const cold = candidate.coldProjects
      .slice(0, 3)
      .map(p => `${p.projectPath} (${p.loadedSessions} loaded session${p.loadedSessions === 1 ? '' : 's'})`)
      .join(', ')
    const coldExtra = candidate.coldProjects.length > 3 ? `, +${candidate.coldProjects.length - 3} more` : ''
    return `${candidate.server}: ${Math.round(candidate.hotShare * 100)}% of ${candidate.invocations} calls in ${hot}; loaded but unused in ${cold}${coldExtra}`
  })
  const extra = candidates.length > preview.length ? `; +${candidates.length - preview.length} more` : ''
  const serverToolCounts = new Map(candidates.map(c => [c.server, c.toolsAvailable]))
  const coldProjectKeysByServer = new Map(candidates.map(c => [c.server, c.coldProjectKeys]))
  const combinedCost = estimateMcpProfileColdSchemaCost(projects, serverToolCounts, coldProjectKeysByServer)
  const tokensSaved = Math.round(combinedCost.effectiveInputTokens)
  const impact: Impact =
    tokensSaved >= MCP_PROFILE_HIGH_IMPACT_TOKENS || candidates.length >= UNUSED_MCP_HIGH_THRESHOLD ? 'high' : 'medium'

  return {
    id: 'mcp-project-scope',
    affectedSessionKeys: new Set(
      projects
        .flatMap(p =>
          p.sessions.filter(s =>
            candidates.some(c => c.coldProjectKeys.has(projectProfileKey(p)) && sessionLoadedMcpServer(s, c.server)),
          ),
        )
        .map(sessionEvidenceKey),
    ),
    title: `${candidates.length} MCP server${candidates.length === 1 ? '' : 's'} should be project-scoped`,
    explanation:
      `These MCP servers look useful in a small set of projects but are loaded into other projects where they are not invoked. ` +
      `Project-scoping them keeps the hot-project workflow while avoiding schema overhead elsewhere. ${lines.join('; ')}${extra}.`,
    impact,
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'prompt',
      label: 'Ask Claude to turn this into a project-scoped MCP profile:',
      text: [
        `Review these MCP profile recommendations before changing config (${preview.length} of ${candidates.length} shown):`,
        ...preview.map(candidate => {
          const hot = candidate.hotProjects.map(p => p.projectPath).join(', ')
          const cold = candidate.coldProjects
            .slice(0, 3)
            .map(p => p.projectPath)
            .join(', ')
          return `- Review project scoping for ${candidate.server}. Recorded use is concentrated in ${hot}; ${cold} have inventory exposure without invocations. Check occasional and unobserved workflows before changing availability.`
        }),
      ].join('\n'),
    },
  }
}

// ============================================================================
// Capability-reliability detector
// ============================================================================

function capabilityKey(ref: CapabilityRef): string {
  return `${ref.kind}:${ref.name}`
}

function formatCapabilityKind(kind: CapabilityKind): string {
  return kind === 'mcp' ? 'MCP server' : 'skill'
}

function mcpServerFromToolName(fqn: string): string | null {
  const parts = fqn.split('__')
  if (parts.length < 3 || parts[0] !== 'mcp') return null
  return parts[1] || null
}

function collectReliabilityCapabilities(
  turn: ProjectSummary['sessions'][number]['turns'][number],
): Map<string, CapabilityRef> {
  const capabilities = new Map<string, CapabilityRef>()

  for (const call of turn.assistantCalls) {
    for (const fqn of call.mcpTools) {
      const server = mcpServerFromToolName(fqn)
      if (!server) continue
      const ref: CapabilityRef = { kind: 'mcp', name: server }
      capabilities.set(capabilityKey(ref), ref)
    }
    for (const rawSkill of call.skills ?? []) {
      const skill = rawSkill.trim()
      if (!skill) continue
      const ref: CapabilityRef = { kind: 'skill', name: skill }
      capabilities.set(capabilityKey(ref), ref)
    }
  }

  return capabilities
}

function turnEffectiveTokenTotal(turn: ProjectSummary['sessions'][number]['turns'][number]): number {
  return Math.round(
    turn.assistantCalls.reduce(
      (sum, call) =>
        sum +
        call.usage.inputTokens +
        call.usage.outputTokens +
        call.usage.cacheCreationInputTokens +
        call.usage.cacheReadInputTokens,
      0,
    ),
  )
}

function reliabilityTurnKey(
  session: ProjectSummary['sessions'][number],
  turn: ProjectSummary['sessions'][number]['turns'][number],
  turnIndex: number,
): string {
  return `${sessionEvidenceKey(session)}:${turn.timestamp}:${turnIndex}`
}

function getReliabilityAccumulator(
  stats: Map<string, CapabilityReliabilityAccumulator>,
  ref: CapabilityRef,
): CapabilityReliabilityAccumulator {
  const key = capabilityKey(ref)
  let acc = stats.get(key)
  if (!acc) {
    acc = {
      ...ref,
      editTurns: 0,
      retryTurns: 0,
      oneShotTurns: 0,
      retries: 0,
      tokensTouched: 0,
      projects: new Set(),
      retryTurnSavings: new Map(),
    }
    stats.set(key, acc)
  }
  return acc
}

function findCapabilityReliabilityCandidates(projects: ProjectSummary[]): Array<{
  kind: CapabilityKind
  name: string
  editTurns: number
  retryTurns: number
  oneShotTurns: number
  retries: number
  retryRate: number
  tokensTouched: number
  tokensSaved: number
  projects: string[]
}> {
  const stats = new Map<string, CapabilityReliabilityAccumulator>()

  for (const project of projects) {
    for (const session of project.sessions) {
      for (let turnIndex = 0; turnIndex < session.turns.length; turnIndex++) {
        const turn = session.turns[turnIndex]!
        if (!turn.hasEdits) continue

        const capabilities = collectReliabilityCapabilities(turn)
        if (capabilities.size === 0) continue

        const turnTokens = turnEffectiveTokenTotal(turn)
        const turnKey = reliabilityTurnKey(session, turn, turnIndex)
        const recoverableTokens = turn.retries > 0 ? turnTokens : 0

        for (const ref of capabilities.values()) {
          const acc = getReliabilityAccumulator(stats, ref)
          acc.editTurns++
          acc.tokensTouched += turnTokens
          acc.projects.add(project.project)
          if (turn.retries > 0) {
            acc.retryTurns++
            acc.retries += turn.retries
            acc.retryTurnSavings.set(turnKey, recoverableTokens)
          } else {
            acc.oneShotTurns++
          }
        }
      }
    }
  }

  const candidates: Array<{
    kind: CapabilityKind
    name: string
    editTurns: number
    retryTurns: number
    oneShotTurns: number
    retries: number
    retryRate: number
    tokensTouched: number
    tokensSaved: number
    projects: string[]
  }> = []
  for (const acc of stats.values()) {
    if (acc.editTurns < CAPABILITY_RELIABILITY_MIN_EDIT_TURNS) continue
    if (acc.retryTurns < CAPABILITY_RELIABILITY_MIN_RETRY_TURNS) continue
    const retryRate = acc.retryTurns / acc.editTurns
    if (retryRate < CAPABILITY_RELIABILITY_MIN_RETRY_RATE) continue

    candidates.push({
      kind: acc.kind,
      name: acc.name,
      editTurns: acc.editTurns,
      retryTurns: acc.retryTurns,
      oneShotTurns: acc.oneShotTurns,
      retries: acc.retries,
      retryRate,
      tokensTouched: acc.tokensTouched,
      tokensSaved: Array.from(acc.retryTurnSavings.values()).reduce((sum, tokens) => sum + tokens, 0),
      projects: Array.from(acc.projects).sort(),
    })
  }

  candidates.sort(
    (a, b) =>
      b.retryRate - a.retryRate ||
      b.retries - a.retries ||
      b.tokensSaved - a.tokensSaved ||
      a.kind.localeCompare(b.kind) ||
      a.name.localeCompare(b.name),
  )
  return candidates
}

export function detectCapabilityReliability(projects: ProjectSummary[]): WasteFinding | null {
  const candidates = findCapabilityReliabilityCandidates(projects)
  if (candidates.length === 0) return null

  const candidateKeys = new Set(candidates.map(c => capabilityKey(c)))
  const uniqueRetryTurnSavings = new Map<string, number>()
  for (const project of projects) {
    for (const session of project.sessions) {
      for (let turnIndex = 0; turnIndex < session.turns.length; turnIndex++) {
        const turn = session.turns[turnIndex]!
        if (!turn.hasEdits || turn.retries <= 0) continue
        const capabilities = collectReliabilityCapabilities(turn)
        if (capabilities.size === 0) continue

        const hasFlaggedCapability = Array.from(capabilities.keys()).some(key => candidateKeys.has(key))
        if (!hasFlaggedCapability) continue

        const key = reliabilityTurnKey(session, turn, turnIndex)
        const tokens = turnEffectiveTokenTotal(turn)
        uniqueRetryTurnSavings.set(key, Math.max(uniqueRetryTurnSavings.get(key) ?? 0, tokens))
      }
    }
  }

  const tokensSaved = Array.from(uniqueRetryTurnSavings.values()).reduce((sum, tokens) => sum + tokens, 0)
  const preview = candidates.slice(0, CAPABILITY_RELIABILITY_PREVIEW)
  const list = preview
    .map(c => {
      const percent = Math.round(c.retryRate * 100)
      const projects =
        c.projects.length > 1 ? ` across ${c.projects.length} projects` : ` in ${c.projects[0] ?? 'one project'}`
      return `${formatCapabilityKind(c.kind)} ${c.name}: ${c.retryTurns}/${c.editTurns} edit turns retried (${percent}%), ${c.retries} retries${projects}`
    })
    .join('; ')
  const extra = candidates.length > preview.length ? `; +${candidates.length - preview.length} more` : ''

  const names = preview.map(c => `${formatCapabilityKind(c.kind)} ${c.name}`).join(', ')

  let impact: Impact
  if (
    candidates.length >= CAPABILITY_RELIABILITY_HIGH_MIN_CANDIDATES ||
    tokensSaved >= CAPABILITY_RELIABILITY_HIGH_IMPACT_TOKENS
  ) {
    impact = 'high'
  } else if (
    candidates.length <= CAPABILITY_RELIABILITY_LOW_MAX_CANDIDATES &&
    tokensSaved < CAPABILITY_RELIABILITY_LOW_MAX_TOKENS
  ) {
    impact = 'low'
  } else {
    impact = 'medium'
  }

  const kindSet = new Set(candidates.map(c => c.kind))
  const noun = kindSet.size === 1 ? (kindSet.has('mcp') ? 'MCP server' : 'skill') : 'MCP/skill capability'
  const pluralNoun = noun === 'MCP/skill capability' ? 'MCP/skill capabilities' : `${noun}s`
  const verb = candidates.length === 1 ? 'correlates' : 'correlate'

  return {
    id: 'retry-heavy-capabilities',
    quantity: { value: uniqueRetryTurnSavings.size, unit: 'turns' },
    affectedSessionKeys: new Set(
      projects
        .flatMap(p => p.sessions)
        .filter(s =>
          s.turns.some(
            t =>
              t.hasEdits &&
              t.retries > 0 &&
              [...collectReliabilityCapabilities(t).keys()].some(key => candidateKeys.has(key)),
          ),
        )
        .map(sessionEvidenceKey),
    ),
    title: `${candidates.length} ${candidates.length === 1 ? noun : pluralNoun} ${verb} with retry-heavy edits`,
    explanation: `Edit turns using these capabilities are retry-heavy: ${list}${extra}. This is a correlation report, not proof of causation; compare the retry-heavy turns with one-shot turns before changing MCP scope or skill instructions.`,
    impact,
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'prompt',
      label: 'Ask your assistant to review the retry-heavy capability before changing config:',
      text: `Investigate these retry-correlated capabilities: ${names}. Compare edit turns with retries against one-shot edit turns, identify whether the MCP server or skill actually caused rework, then propose a scoped MCP config or skill-instruction change with session evidence. Do not remove a capability solely because it appears in this report.`,
    },
  }
}

// ============================================================================
// MCP deferral-gap detectors (detection only, no apply plans ÔÇö ADR 0008)
// ============================================================================

function observedMcpServers(steps: ScanStep[]): Set<string> {
  const servers = new Set<string>()
  for (const step of steps) {
    if (!step.name.startsWith('mcp__')) continue
    const seg = step.name.split('__')[1]
    if (seg) servers.add(seg)
  }
  return servers
}

function attributeDeferralOffCause(
  enableToolSearch: DeferralEnvHit | null,
  envSettings: Map<string, DeferralEnvHit | null>,
  home: string,
): { cause: string; fix: WasteAction } {
  const observations: string[] = []
  if (enableToolSearch) {
    observations.push(
      `${ENABLE_TOOL_SEARCH_VAR}=${enableToolSearch.value} is currently set in ${enableToolSearch.scope} (${shortHomePath(enableToolSearch.path, home)}).`,
    )
  }
  const baseUrl = envSettings.get(ANTHROPIC_BASE_URL_VAR)
  if (baseUrl && !isFirstPartyBaseUrl(baseUrl.value))
    observations.push(
      'Current configuration uses a custom endpoint. Its tool-discovery compatibility has not been inspected.',
    )
  const vertex = envSettings.get(CLAUDE_CODE_USE_VERTEX_VAR)
  if (vertex && !isEnvValueFalse(vertex.value))
    observations.push(
      'A Vertex setting is present in current configuration. Supported discovery behavior depends on the installed integration.',
    )
  if (observations.length === 0) observations.push('No tool-search override is visible in current configuration.')
  const cause = `${observations.join(' ')} Missing transcript signals do not establish that deferral was disabled or that enabling it would help.`
  return {
    cause,
    fix: {
      type: 'paste',
      destination: 'prompt',
      label: 'Review tool discovery support before changing settings:',
      text: `Check the installed Claude Code version, effective project settings, endpoint compatibility and tool availability before changing ${ENABLE_TOOL_SEARCH_VAR}. ${observations.join(' ')} Confirm that discovery is supported and appropriate for this workflow. Do not force a setting or remove an override solely because no ToolSearch calls or deferred inventory were captured.`,
    },
  }
}

export function detectMcpDeferralOff(
  steps: ScanStep[],
  projects: ProjectSummary[],
  setup: OptimizeSetup,
): WasteFinding | null {
  if (steps.some(s => s.name === TOOL_SEARCH_TOOL_NAME)) return null
  if (anySessionHasMcpInventory(projects)) return null

  const { home } = setup
  const configured = setup.mcpConfigs
  const pinnedServers = new Set(
    [...configured.values()].filter(e => e.alwaysLoadPaths.length > 0).map(e => e.normalized),
  )
  const configuredUnpinned = [...configured.keys()].filter(s => !pinnedServers.has(s))

  const observedServers = observedMcpServers(steps)
  let invocations = 0
  let sessionsWithMcpCalls = 0
  let totalSessions = 0
  for (const project of projects) {
    for (const session of project.sessions) {
      if (!isClaudeSession(session)) continue
      totalSessions++
      let sessionCalls = 0
      for (const [server, data] of Object.entries(session.mcpBreakdown)) {
        if (pinnedServers.has(server)) continue
        observedServers.add(server)
        sessionCalls += data.calls
      }
      if (sessionCalls > 0) sessionsWithMcpCalls++
      invocations += sessionCalls
    }
  }

  const servers = new Set([...configuredUnpinned, ...observedServers])
  if (servers.size === 0) return null

  const affectedSessions = configuredUnpinned.length > 0 ? totalSessions : sessionsWithMcpCalls
  if (affectedSessions < DEFERRAL_OFF_MIN_MCP_SESSIONS) return null

  const enableToolSearch = setup.envSettings.get(ENABLE_TOOL_SEARCH_VAR) ?? null
  if (enableToolSearch && /^auto(?::\d+)?$/.test(enableToolSearch.value)) return null

  const perServerSchemaTokens = TOOLS_PER_MCP_SERVER * TOKENS_PER_MCP_TOOL
  const perSessionSchemaTokens = servers.size * perServerSchemaTokens
  const tokensSaved = perSessionSchemaTokens * affectedSessions
  const callRate = affectedSessions > 0 ? invocations / affectedSessions : 0
  const callRateText = callRate.toFixed(1)

  const evidence =
    `Current configuration and selected transcripts suggest reviewing ${servers.size} MCP server${servers.size === 1 ? '' : 's'}. ` +
    `${affectedSessions} selected Claude session${affectedSessions === 1 ? '' : 's'} have no recorded ToolSearch or deferred-tool inventory, ` +
    `with ${callRateText} MCP calls/session. A rough schema model is ${formatTokens(perSessionSchemaTokens)} tokens per session, ` +
    `using ${formatTokens(perServerSchemaTokens)} tokens/server. Actual prompt exposure and historical configuration are unknown.`

  const { cause, fix } = attributeDeferralOffCause(enableToolSearch, setup.envSettings, home)

  return {
    id: 'mcp-deferral-off',
    title: 'Review MCP tool deferral configuration',
    explanation: `${evidence} ${cause}`,
    impact: tokensSaved >= DEFERRAL_OFF_HIGH_IMPACT_TOKENS ? 'high' : 'medium',
    tokensSaved,
    fix,
  }
}

export function detectMcpAlwaysLoadHygiene(
  projects: ProjectSummary[],
  setup: OptimizeSetup,
  mcpCoverage = aggregateMcpCoverage(projects),
): WasteFinding | null {
  const { home } = setup
  const configured = setup.mcpConfigs
  const pinned = [...configured.values()].filter(e => e.alwaysLoadPaths.length > 0)
  if (pinned.length === 0) return null

  // The desktop report does not persist the Claude Code version per call, so
  // the "every version predates alwaysLoad support" gate is skipped: a pin is
  // assumed supported, matching the optimistic reading.
  const totalSessions = projects.reduce((s, p) => s + p.sessions.length, 0)
  if (totalSessions === 0) return null

  const coverageByServer = new Map(mcpCoverage.map(c => [c.server, c]))
  const invocationsByServer = new Map<string, number>()
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const [server, data] of Object.entries(session.mcpBreakdown)) {
        invocationsByServer.set(server, (invocationsByServer.get(server) ?? 0) + data.calls)
      }
    }
  }

  const lines: string[] = []
  const fixLines: string[] = []
  let tokensSaved = 0
  for (const entry of pinned) {
    const invocations = invocationsByServer.get(entry.normalized) ?? 0
    const callRate = invocations / totalSessions
    if (callRate >= ALWAYSLOAD_MAX_CALLS_PER_SESSION) continue
    const coverage = coverageByServer.get(entry.normalized)
    const toolsAvailable = coverage?.toolsAvailable ?? TOOLS_PER_MCP_SERVER
    const loadedSessions = coverage?.loadedSessions ?? totalSessions
    tokensSaved += toolsAvailable * TOKENS_PER_MCP_TOOL * loadedSessions
    lines.push(
      `${entry.original}: ${invocations} call${invocations === 1 ? '' : 's'} across ${totalSessions} session${totalSessions === 1 ? '' : 's'}`,
    )
    fixLines.push(
      `- Review the alwaysLoad pin for ${entry.original} in ${entry.alwaysLoadPaths.map(p => shortHomePath(p, home)).join(', ')}. Check tool discovery, startup needs and occasional workflows before changing it.`,
    )
  }
  if (lines.length === 0) return null

  return {
    id: 'mcp-alwaysload-hygiene',
    title: `${lines.length} alwaysLoad MCP server${lines.length === 1 ? '' : 's'} rarely used`,
    explanation:
      `These servers are currently pinned with alwaysLoad and have sparse recorded invocations in the selected Claude sessions: ${lines.join('; ')}. ` +
      `Current pins do not establish historical prompt exposure or whether occasional workflows need them.`,
    impact: tokensSaved >= ALWAYSLOAD_HIGH_IMPACT_TOKENS ? 'high' : 'medium',
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'prompt',
      label: 'Review current pins before changing availability:',
      text: fixLines.join('\n'),
    },
  }
}

export function detectMcpDeferThreshold(projects: ProjectSummary[], setup: OptimizeSetup): WasteFinding | null {
  const { home } = setup
  const setting = setup.envSettings.get(ENABLE_TOOL_SEARCH_VAR) ?? null
  if (!setting) return null
  const match = /^auto(?::(\d+))?$/.exec(setting.value)
  if (!match) return null
  const percent =
    match[1] !== undefined
      ? Math.min(DEFER_THRESHOLD_MAX_PERCENT, parseInt(match[1], 10))
      : DEFER_THRESHOLD_DEFAULT_PERCENT

  if (anySessionHasMcpInventory(projects)) return null

  const configured = setup.mcpConfigs
  const servers = new Set(configured.keys())
  let totalSessions = 0
  for (const project of projects) {
    for (const session of project.sessions) {
      if (!isClaudeSession(session)) continue
      totalSessions++
      for (const server of Object.keys(session.mcpBreakdown)) servers.add(server)
    }
  }
  if (servers.size === 0) return null
  if (totalSessions === 0) return null

  const defsPerSession = servers.size * TOOLS_PER_MCP_SERVER * TOKENS_PER_MCP_TOOL
  const onePercent = DEFER_THRESHOLD_CONTEXT_WINDOW_TOKENS / 100
  const thresholdTokens = percent * onePercent
  if (defsPerSession > thresholdTokens) return null
  if (defsPerSession < DEFER_THRESHOLD_MIN_TOKENS_PER_SESSION) return null

  const tokensSaved = defsPerSession * totalSessions
  const recommendedPercent = Math.max(0, Math.ceil(defsPerSession / onePercent) - 1)
  const removeOverride = defsPerSession > DEFER_THRESHOLD_DEFAULT_PERCENT * onePercent

  return {
    id: 'mcp-defer-threshold',
    title: 'Review the current MCP tool search threshold',
    explanation:
      `${ENABLE_TOOL_SEARCH_VAR}=${setting.value} is set in ${setting.scope} (${shortHomePath(setting.path, home)}), ` +
      `deferring MCP tool definitions only when they exceed ${percent}% of the ${formatTokens(DEFER_THRESHOLD_CONTEXT_WINDOW_TOKENS)}-token context window ` +
      `(~${formatTokens(thresholdTokens)} tokens). Your estimated ~${formatTokens(defsPerSession)} tokens of definitions per session fit under that, ` +
      `so this model suggests reviewing the current threshold. Actual context-window size, serialized definitions and historical loading behavior are unknown.`,
    impact: tokensSaved >= DEFER_THRESHOLD_MEDIUM_IMPACT_TOKENS ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'prompt',
      label: 'Review the current auto threshold against the installed Claude version:',
      text: removeOverride
        ? `Review ${ENABLE_TOOL_SEARCH_VAR}=${setting.value} in ${setting.path}. Compare the installed version's default threshold and actual tool-definition size before deciding whether to remove this override.`
        : `Review ${ENABLE_TOOL_SEARCH_VAR}=${setting.value} in ${setting.path}. A model based on assumed definition size suggests auto:${recommendedPercent}; verify the installed version's syntax, context window and tool discovery behavior before changing it.`,
    },
  }
}

// ============================================================================
// Ghost-agent/skill/command detectors
// ============================================================================

export function detectGhostAgents(subagentTypes: Iterable<string>, defined: string[]): WasteFinding | null {
  if (defined.length === 0) return null

  const invoked = new Set(subagentTypes)
  const ghosts = defined.filter(name => !invoked.has(name))
  if (ghosts.length === 0) return null

  const tokensSaved = ghosts.length * TOKENS_PER_AGENT_DEF
  const list =
    ghosts.slice(0, GHOST_NAMES_PREVIEW).join(', ') +
    (ghosts.length > GHOST_NAMES_PREVIEW ? `, +${ghosts.length - GHOST_NAMES_PREVIEW} more` : '')

  return {
    id: 'unused-agents',
    title: `${ghosts.length} current custom agent${ghosts.length > 1 ? 's' : ''} without observed use`,
    explanation: `Currently defined in ~/.claude/agents/ without recorded invocations in the selected Claude sessions: ${list}. Current definitions may not have existed during those sessions; prompt exposure is unknown.`,
    impact:
      ghosts.length >= GHOST_AGENTS_HIGH_THRESHOLD
        ? 'high'
        : ghosts.length >= GHOST_AGENTS_MEDIUM_THRESHOLD
          ? 'medium'
          : 'low',
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'prompt',
      label: 'Review current agents before making changes:',
      text: `Review these current agents without observed use: ${ghosts.join(', ')}. Check whether they were available during the selected sessions and whether occasional or unobserved workflows still need them. Suggest changes for review.`,
    },
  }
}

export function detectGhostSkills(skills: Iterable<string>, defined: string[]): WasteFinding | null {
  if (defined.length === 0) return null

  const invoked = new Set(skills)
  const ghosts = defined.filter(name => !invoked.has(name))
  if (ghosts.length === 0) return null

  const tokensSaved = ghosts.length * TOKENS_PER_SKILL_DEF
  const list =
    ghosts.slice(0, GHOST_NAMES_PREVIEW).join(', ') +
    (ghosts.length > GHOST_NAMES_PREVIEW ? `, +${ghosts.length - GHOST_NAMES_PREVIEW} more` : '')

  return {
    id: 'unused-skills',
    title: `${ghosts.length} current skill${ghosts.length > 1 ? 's' : ''} without observed use`,
    explanation: `Currently defined in ~/.claude/skills/ without recorded invocations in the selected Claude sessions: ${list}. Definition history and actual prompt exposure are unknown.`,
    impact:
      ghosts.length >= GHOST_SKILLS_HIGH_THRESHOLD
        ? 'high'
        : ghosts.length >= GHOST_SKILLS_MEDIUM_THRESHOLD
          ? 'medium'
          : 'low',
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'prompt',
      label: 'Review current skills before making changes:',
      text: `Review these current skills without observed use: ${ghosts.join(', ')}. Check whether they were available during the selected sessions and whether occasional or unobserved workflows still need them. Suggest changes for review.`,
    },
  }
}

const COMMAND_PATTERN = /<command-name>([^<]+)<\/command-name>|(?:^|\s)\/([a-zA-Z][\w-]*)/gm

export function detectGhostCommands(userMessages: string[], defined: string[]): WasteFinding | null {
  if (defined.length === 0) return null

  const invoked = new Set<string>()
  for (const msg of userMessages) {
    COMMAND_PATTERN.lastIndex = 0
    for (const m of msg.matchAll(COMMAND_PATTERN)) {
      const name = (m[1] || m[2] || '').trim()
      if (name) invoked.add(name)
    }
  }

  const ghosts = defined.filter(name => !invoked.has(name))
  if (ghosts.length === 0) return null

  const tokensSaved = ghosts.length * TOKENS_PER_COMMAND_DEF
  const list =
    ghosts.slice(0, GHOST_NAMES_PREVIEW).join(', ') +
    (ghosts.length > GHOST_NAMES_PREVIEW ? `, +${ghosts.length - GHOST_NAMES_PREVIEW} more` : '')

  return {
    id: 'unused-commands',
    title: `${ghosts.length} current slash command${ghosts.length > 1 ? 's' : ''} without observed use`,
    explanation: `Currently defined in ~/.claude/commands/ without recorded references in selected Claude sessions: ${list}. Command matching uses capped user messages, so missing references do not establish non-use.`,
    impact: ghosts.length >= GHOST_COMMANDS_MEDIUM_THRESHOLD ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'prompt',
      label: 'Review current commands before making changes:',
      text: `Review these current commands without observed use: ${ghosts.join(', ')}. Check whether they were available during the selected sessions and whether occasional or unobserved workflows still need them. Suggest changes for review.`,
    },
  }
}

// ============================================================================
// Low-worth / context-bloat / session-outlier detectors
// ============================================================================

function sessionTokenTotal(session: SessionSummary): number {
  return (
    session.totalInputTokens + session.totalOutputTokens + session.totalCacheReadTokens + session.totalCacheWriteTokens
  )
}

function sessionEffectiveContextTokens(session: SessionSummary): number {
  return session.totalInputTokens + session.totalCacheReadTokens + session.totalCacheWriteTokens
}

function formatContextRatio(ratio: number): string {
  if (ratio >= CONTEXT_BLOAT_RATIO_DISPLAY_CAP) return `${CONTEXT_BLOAT_RATIO_DISPLAY_CAP}+`
  return ratio.toFixed(1)
}

const DELIVERY_COMMAND_PATTERNS = [
  /(?:^|[;&|]\s*)git\s+(?:commit|push)(?=\s|$|--)(?![^;&|]*--dry-run)/,
  /(?:^|[;&|]\s*)gh\s+pr\s+(?:create|merge)(?=\s|$|--)(?![^;&|]*--dry-run)/,
]

function sessionDeliveryCommand(session: SessionSummary): string | null {
  const commands = Object.keys(session.bashBreakdown)
  return commands.find(command => DELIVERY_COMMAND_PATTERNS.some(pattern => pattern.test(command))) ?? null
}

function hasCategoryBreakdownData(session: SessionSummary): boolean {
  return Object.values(session.categoryBreakdown).some(
    category =>
      category.turns > 0 ||
      category.costUSD > 0 ||
      category.retries > 0 ||
      category.editTurns > 0 ||
      category.oneShotTurns > 0,
  )
}

function sessionEditTurns(session: SessionSummary): number {
  if (hasCategoryBreakdownData(session)) {
    return Object.values(session.categoryBreakdown).reduce((sum, c) => sum + c.editTurns, 0)
  }
  return session.turns.filter(turn => turn.hasEdits).length
}

function sessionOneShotTurns(session: SessionSummary): number {
  if (hasCategoryBreakdownData(session)) {
    return Object.values(session.categoryBreakdown).reduce((sum, c) => sum + c.oneShotTurns, 0)
  }
  return session.turns.filter(turn => turn.hasEdits && turn.retries === 0).length
}

function sessionRetryCount(session: SessionSummary): number {
  if (hasCategoryBreakdownData(session)) {
    return Object.values(session.categoryBreakdown).reduce((sum, c) => sum + c.retries, 0)
  }
  return session.turns.reduce((sum, turn) => sum + turn.retries, 0)
}

export const LOW_WORTH_OPENER =
  'Before continuing, name the deliverable in one sentence (PR title, file changed, command output you expect). Stop and check with me if (a) you spend more than 10 minutes without an edit, or (b) the same approach fails twice. Do not retry past two attempts on any single fix.'
export const CONTEXT_HEAVY_OPENER =
  'Start fresh before continuing. Use only the current goal, the relevant files, the failing command/output, and the constraints below. Restate the working context in under 10 bullets before editing.'

export function findLowWorthCandidates(projects: ProjectSummary[]): LowWorthCandidate[] {
  const candidates: LowWorthCandidate[] = []

  for (const project of projects) {
    for (const session of project.sessions) {
      if (!isHumanSession(session)) continue
      if (session.totalCostUSD < WORTH_IT_MIN_COST_USD) continue
      if (sessionDeliveryCommand(session)) continue

      const editTurns = sessionEditTurns(session)
      const oneShotTurns = sessionOneShotTurns(session)
      const retries = sessionRetryCount(session)
      const reasons: string[] = []

      if (editTurns === 0 && session.totalCostUSD >= WORTH_IT_NO_EDIT_MIN_COST_USD) {
        reasons.push('no edit turns')
      }
      if (retries >= WORTH_IT_MIN_RETRIES) {
        reasons.push(`${retries} retries`)
      }
      if (editTurns > 0 && oneShotTurns === 0 && retries >= WORTH_IT_RETRY_WITH_EDIT_MIN_RETRIES) {
        reasons.push('no one-shot edit turns')
      }

      if (reasons.length === 0) continue

      candidates.push({
        project: project.project,
        sessionId: session.sessionId,
        key: sessionEvidenceKey(session),
        date: session.firstTimestamp.slice(0, 10),
        cost: session.totalCostUSD,
        tokens: sessionTokenTotal(session),
        reasons,
      })
    }
  }

  candidates.sort(
    (a, b) =>
      b.cost - a.cost ||
      a.date.localeCompare(b.date) ||
      a.project.localeCompare(b.project) ||
      a.sessionId.localeCompare(b.sessionId),
  )
  return candidates
}

export function detectLowWorthSessions(projects: ProjectSummary[]): WasteFinding | null {
  const candidates = findLowWorthCandidates(projects)
  if (candidates.length === 0) return null

  const preview = candidates.slice(0, WORTH_IT_PREVIEW)
  const list = preview
    .map(s => `${s.project}/${s.sessionId} on ${s.date}: $${s.cost.toFixed(2)} (${s.reasons.join(', ')})`)
    .join('; ')
  const extra = candidates.length > preview.length ? `; +${candidates.length - preview.length} more` : ''
  const tokensSaved = Math.round(candidates.reduce((sum, s) => sum + s.tokens, 0))
  const totalCost = candidates.reduce((sum, s) => sum + s.cost, 0)

  let impact: Impact
  if (candidates.length >= WORTH_IT_HIGH_MIN_CANDIDATES || totalCost >= WORTH_IT_HIGH_TOTAL_COST_USD) {
    impact = 'high'
  } else if (candidates.length <= WORTH_IT_LOW_MAX_CANDIDATES && totalCost < WORTH_IT_LOW_MAX_TOTAL_COST_USD) {
    impact = 'low'
  } else {
    impact = 'medium'
  }

  return {
    id: 'low-worth-sessions',
    title: `${candidates.length} expensive session${candidates.length === 1 ? '' : 's'} to review`,
    explanation: `Sessions with meaningful spend but weak delivery signals: ${list}${extra}. This is a review candidate, not proof of waste: Watchtower flags missing edit turns, repeated retries, and sessions without git delivery commands so you can decide whether the work was worth its cost before it becomes a habit.`,
    impact,
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'session-opener',
      label: 'Use once at the start of a session. Review before making a persistent instruction:',
      text: LOW_WORTH_OPENER,
    },
  }
}

export function findContextBloatCandidates(projects: ProjectSummary[]): ContextBloatCandidate[] {
  const candidates: ContextBloatCandidate[] = []

  for (const project of projects) {
    const sessions = project.sessions
      .filter(isHumanSession)
      .sort((a, b) => new Date(a.firstTimestamp).getTime() - new Date(b.firstTimestamp).getTime())
    const previousByProvider = new Map<string, { inputTokens: number; timestampMs: number }>()

    for (const session of sessions) {
      const inputTokens = sessionEffectiveContextTokens(session)
      const outputTokens = session.totalOutputTokens
      const ratio = inputTokens / Math.max(outputTokens, 1)
      const currentMs = new Date(session.firstTimestamp).getTime()
      const provider = session.turns[0]?.assistantCalls[0]?.provider ?? 'unknown'
      const previous = previousByProvider.get(provider)
      const previousInputTokens = previous?.inputTokens ?? null
      const previousTimestampMs = previous?.timestampMs ?? null
      const gapMs = previousTimestampMs !== null ? currentMs - previousTimestampMs : null
      const growthRatio =
        previousInputTokens !== null &&
        previousInputTokens > 0 &&
        gapMs !== null &&
        gapMs <= CONTEXT_BLOAT_GROWTH_MAX_GAP_MS
          ? inputTokens / previousInputTokens
          : null

      previousByProvider.set(provider, { inputTokens, timestampMs: currentMs })

      if (inputTokens < CONTEXT_BLOAT_MIN_INPUT_TOKENS) continue
      if (ratio < CONTEXT_BLOAT_MIN_RATIO) continue

      candidates.push({
        project: project.project,
        sessionId: session.sessionId,
        date: session.firstTimestamp.slice(0, 10),
        key: sessionEvidenceKey(session),
        effectiveInputTokens: inputTokens,
        outputTokens,
        ratio,
        excessInputTokens: Math.max(0, inputTokens - outputTokens * CONTEXT_BLOAT_TARGET_RATIO),
        growthRatio,
      })
    }
  }

  candidates.sort(
    (a, b) =>
      b.excessInputTokens - a.excessInputTokens ||
      a.date.localeCompare(b.date) ||
      a.project.localeCompare(b.project) ||
      a.sessionId.localeCompare(b.sessionId),
  )
  return candidates
}

export function detectContextBloat(
  projects: ProjectSummary[],
  excludedSessionIds?: ReadonlySet<string>,
): WasteFinding | null {
  const candidates = findContextBloatCandidates(projects).filter(
    c => !excludedSessionIds?.has(c.key ?? c.sessionId) && !excludedSessionIds?.has(c.sessionId),
  )
  if (candidates.length === 0) return null

  const preview = candidates.slice(0, CONTEXT_BLOAT_PREVIEW)
  const list = preview
    .map(c => {
      const growth =
        c.growthRatio !== null && c.growthRatio >= CONTEXT_BLOAT_GROWTH_RATIO
          ? `, ${c.growthRatio.toFixed(1)}x previous session input`
          : ''
      return `${c.project}/${c.sessionId} on ${c.date}: ${formatTokens(c.effectiveInputTokens)} input/cache vs ${formatTokens(c.outputTokens)} output (${formatContextRatio(c.ratio)}:1${growth})`
    })
    .join('; ')
  const extra = candidates.length > preview.length ? `; +${candidates.length - preview.length} more` : ''
  const tokensSaved = Math.round(candidates.reduce((sum, c) => sum + c.excessInputTokens, 0))
  const totalInputTokens = candidates.reduce((sum, c) => sum + c.effectiveInputTokens, 0)

  let impact: Impact
  if (candidates.length >= CONTEXT_BLOAT_HIGH_MIN_CANDIDATES || totalInputTokens >= CONTEXT_BLOAT_HIGH_INPUT_TOKENS) {
    impact = 'high'
  } else if (
    candidates.length <= CONTEXT_BLOAT_LOW_MAX_CANDIDATES &&
    totalInputTokens < CONTEXT_BLOAT_LOW_INPUT_TOKENS
  ) {
    impact = 'low'
  } else {
    impact = 'medium'
  }

  return {
    id: 'context-heavy-sessions',
    title: `${candidates.length} context-heavy session${candidates.length === 1 ? '' : 's'}`,
    explanation: `Recorded input/cache token volume exceeds output in these sessions: ${list}${extra}. This can come from stale context carryover, inherently context-heavy work, or unfinished runs that loaded substantial context; starting fresh with only the current goal and relevant files can cut repeated prompt overhead.`,
    impact,
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'session-opener',
      label: 'Use once at the start of a session. Review before making a persistent instruction:',
      text: CONTEXT_HEAVY_OPENER,
    },
  }
}

export function detectSessionOutliers(
  projects: ProjectSummary[],
  excludedSessionIds?: ReadonlySet<string>,
): WasteFinding | null {
  type Outlier = {
    project: string
    sessionId: string
    key: string
    date: string
    cost: number
    avgCost: number
    ratio: number
    tokenExcess: number
  }

  const outliers: Outlier[] = []

  for (const project of projects) {
    const sessions = project.sessions.filter(s => s.totalCostUSD > 0 && isHumanSession(s))
    if (sessions.length < MIN_SESSIONS_FOR_OUTLIER) continue

    const cohorts = new Map<string, { sessions: SessionSummary[]; cost: number; tokens: number }>()
    for (const session of sessions) {
      const providers = new Set(session.turns.flatMap(turn => turn.assistantCalls.map(call => call.provider)))
      if (providers.size !== 1) continue
      const key = JSON.stringify([[...providers][0], (session.totalEstimatedCostUSD ?? 0) > 0])
      const cohort = cohorts.get(key) ?? { sessions: [], cost: 0, tokens: 0 }
      cohort.sessions.push(session)
      cohort.cost += session.totalCostUSD
      cohort.tokens += sessionTokenTotal(session)
      cohorts.set(key, cohort)
    }
    for (const cohort of cohorts.values()) {
      if (cohort.sessions.length < MIN_SESSIONS_FOR_OUTLIER) continue
      for (const session of cohort.sessions) {
        const peerCount = cohort.sessions.length - 1
        const avgCost = (cohort.cost - session.totalCostUSD) / peerCount
        const avgTokens = (cohort.tokens - sessionTokenTotal(session)) / peerCount
        if (avgCost <= 0) continue
        const ratio = session.totalCostUSD / avgCost
        if (ratio <= SESSION_OUTLIER_MULTIPLIER || session.totalCostUSD < MIN_SESSION_OUTLIER_COST_USD) continue
        if (excludedSessionIds?.has(sessionEvidenceKey(session)) || excludedSessionIds?.has(session.sessionId)) continue
        outliers.push({
          project: project.project,
          sessionId: session.sessionId,
          key: sessionEvidenceKey(session),
          date: session.firstTimestamp.slice(0, 10),
          cost: session.totalCostUSD,
          avgCost,
          ratio,
          tokenExcess: Math.max(0, sessionTokenTotal(session) - avgTokens),
        })
      }
    }
  }

  if (outliers.length === 0) return null

  outliers.sort((a, b) => b.cost - a.cost)
  const preview = outliers.slice(0, SESSION_OUTLIER_PREVIEW)
  const list = preview
    .map(o => `${o.project}/${o.sessionId} on ${o.date}: $${o.cost.toFixed(2)} (${o.ratio.toFixed(1)}x avg)`)
    .join('; ')
  const extra = outliers.length > preview.length ? `; +${outliers.length - preview.length} more` : ''
  const tokensSaved = Math.round(outliers.reduce((sum, o) => sum + o.tokenExcess, 0))
  const totalExcessCost = outliers.reduce((sum, o) => sum + Math.max(0, o.cost - o.avgCost), 0)

  return {
    id: 'cost-outliers',
    quantity: { value: outliers.length, unit: 'sessions' },
    affectedSessionKeys: new Set(outliers.map(o => o.key)),
    title: `${outliers.length} high-cost session outlier${outliers.length === 1 ? '' : 's'}`,
    explanation: `Sessions costing more than ${SESSION_OUTLIER_MULTIPLIER}x their same-provider and same cost-provenance peer-session average in the same project: ${list}${extra}. Task complexity, duration, model and pricing can explain differences. Peers are not matched by task, so review the evidence before changing behavior.`,
    impact: outliers.length >= 3 || totalExcessCost >= 10 ? 'high' : 'medium',
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'session-opener',
      label: 'Use once at the start of a session. Review before making a persistent instruction:',
      text: 'Before making changes, summarize the smallest viable plan. Keep context narrow, avoid broad searches, and stop after the first working patch so I can review before continuing.',
    },
  }
}

function findYoungProjectFirstSessionIds(projects: ProjectSummary[]): Set<string> {
  const firstSessionIds = new Set<string>()

  for (const project of projects) {
    const costed = project.sessions.filter(s => s.totalCostUSD > 0)
    if (costed.length >= YOUNG_PROJECT_SESSION_LIMIT) continue

    let firstSession: SessionSummary | null = null
    for (const session of costed) {
      if (
        firstSession === null ||
        new Date(session.firstTimestamp).getTime() < new Date(firstSession.firstTimestamp).getTime()
      ) {
        firstSession = session
      }
    }

    if (firstSession) firstSessionIds.add(sessionEvidenceKey(firstSession))
  }

  return firstSessionIds
}

// ============================================================================
// Scoring
// ============================================================================

const HEALTH_WEIGHTS: Record<Impact, number> = {
  high: HEALTH_WEIGHT_HIGH,
  medium: HEALTH_WEIGHT_MEDIUM,
  low: HEALTH_WEIGHT_LOW,
}

export function computeHealth(findings: WasteFinding[]): { score: number; grade: HealthGrade } {
  if (findings.length === 0) return { score: 100, grade: 'A' }
  let penalty = 0
  for (const f of findings) penalty += HEALTH_WEIGHTS[f.impact] ?? 0
  const score = Math.max(0, 100 - Math.min(HEALTH_MAX_PENALTY, penalty))
  const grade: HealthGrade =
    score >= GRADE_A_MIN
      ? 'A'
      : score >= GRADE_B_MIN
        ? 'B'
        : score >= GRADE_C_MIN
          ? 'C'
          : score >= GRADE_D_MIN
            ? 'D'
            : 'F'
  return { score, grade }
}

function urgencyScore(f: WasteFinding): number {
  const normalizedTokens = Math.min(1, f.tokensSaved / URGENCY_TOKEN_NORMALIZE)
  return URGENCY_WEIGHTS[f.impact] * URGENCY_IMPACT_WEIGHT + normalizedTokens * URGENCY_TOKEN_WEIGHT
}

type TrendInputs = {
  recentCount: number
  recentWindowMs: number
  baselineCount: number
  baselineWindowMs: number
  hasRecentActivity: boolean
}

export function computeTrend(inputs: TrendInputs): Trend | 'resolved' | null {
  const { recentCount, recentWindowMs, baselineCount, baselineWindowMs, hasRecentActivity } = inputs
  if (baselineCount === 0 || baselineWindowMs <= 0 || recentWindowMs <= 0) return null
  if (recentCount === 0 && hasRecentActivity) return 'resolved'
  if (!hasRecentActivity) return null
  const baselineRate = baselineCount / baselineWindowMs
  const recentRate = recentCount / Math.max(recentWindowMs, 1)
  if (recentRate < baselineRate * IMPROVING_THRESHOLD) return 'improving'
  return 'active'
}

function sessionTrend(
  recentItemCount: number,
  totalItemCount: number,
  dateRange: DateRange | undefined,
  hasRecentActivity: boolean,
  now = new Date(),
): Trend | 'resolved' | null {
  const nowMs = now.getTime()
  const baselineCount = totalItemCount - recentItemCount
  const periodStart = dateRange ? dateRange.start.getTime() : nowMs - DEFAULT_TREND_PERIOD_MS
  const recentStart = nowMs - RECENT_WINDOW_MS
  const baselineWindowMs = Math.max(recentStart - periodStart, 1)
  return computeTrend({
    recentCount: recentItemCount,
    recentWindowMs: RECENT_WINDOW_MS,
    baselineCount,
    baselineWindowMs,
    hasRecentActivity,
  })
}

// ============================================================================
// Scope + main entry point
// ============================================================================

export type { DateRange }
export { scopeDateRange }

function selectSessions(projects: ProjectSummary[], include: (session: SessionSummary) => boolean): ProjectSummary[] {
  return projects.map(p => ({ ...p, sessions: p.sessions.filter(include) })).filter(p => p.sessions.length > 0)
}

function sessionEvidenceKey(session: SessionSummary): string {
  return `${session.sourceId ?? session.projectKey ?? session.project}:${session.sessionId}`
}

function isHumanSession(session: SessionSummary): boolean {
  return !session.isSidechain && !session.parentSessionId
}

/** A nonzero cache counter establishes that the transcript captures caching.
 * All-zero counters cannot distinguish missing instrumentation from no caching. */
export function detectLowCacheReuse(projects: ProjectSummary[]): WasteFinding | null {
  const affected: SessionSummary[] = []
  let calls = 0
  for (const session of projects.flatMap(p => p.sessions)) {
    if (session.apiCalls < MIN_API_CALLS_FOR_CACHE) continue
    const cacheTokens = session.totalCacheReadTokens + session.totalCacheWriteTokens
    const inputTokens = session.totalInputTokens + cacheTokens
    if (cacheTokens <= 0 || inputTokens <= 0) continue
    if (session.totalCacheReadTokens / inputTokens >= 0.1) continue
    affected.push(session)
    calls += session.apiCalls
  }
  if (affected.length === 0) return null
  return {
    id: 'low-cache-reuse',
    title: 'Low observed cache reuse',
    explanation: `${affected.length} sessions with at least ${MIN_API_CALLS_FOR_CACHE} calls and recorded cache activity reused less than 10% of input/cache tokens. Prompt changes, short contexts, provider cache policy and task requirements can explain this. All-zero counters are excluded because capture may be unavailable.`,
    impact: 'low',
    tokensSaved: 0,
    quantity: { value: calls, unit: 'calls' },
    affectedSessionKeys: new Set(affected.map(sessionEvidenceKey)),
    fix: {
      type: 'paste',
      destination: 'prompt',
      label: 'Investigate cache behavior:',
      text: 'Review prompt-prefix stability, model changes and tool-definition changes. Check the installed provider documentation for cache eligibility and retention before changing settings.',
    },
  }
}

function detectRecordedFailures(projects: ProjectSummary[], interruption: boolean): WasteFinding | null {
  const affected: SessionSummary[] = []
  let calls = 0
  for (const session of projects.flatMap(p => p.sessions)) {
    const matchingCalls = session.turns
      .flatMap(t => t.assistantCalls)
      .filter(c => (interruption ? c.interrupted : (c.toolErrors ?? 0) > 0 || (c.editFailed ?? 0) > 0)).length
    if (matchingCalls === 0) continue
    calls += matchingCalls
    affected.push(session)
  }
  if (calls === 0) return null
  return {
    id: interruption ? 'interrupted-calls' : 'tool-failures',
    title: interruption ? 'Calls with recorded interruptions' : 'Calls with recorded tool failures',
    explanation: `${calls} calls in ${affected.length} sessions contain ${interruption ? 'an explicit interruption flag' : 'tool-error or failed-edit metadata'}. This is observed execution evidence. Interruptions may be deliberate, and errors may be expected probes. Associated session spend includes successful work and is not recoverable waste.`,
    impact: 'low',
    tokensSaved: 0,
    quantity: { value: calls, unit: 'calls' },
    affectedSessionKeys: new Set(affected.map(sessionEvidenceKey)),
    fix: {
      type: 'paste',
      destination: 'prompt',
      label: 'Review the affected session before changing the workflow:',
      text: 'Review recorded failures and interruptions. Separate expected probes and deliberate stops from repeated avoidable failures, then address the specific failing tool or edit.',
    },
  }
}

const SETUP_FINDING_IDS = new Set<OptimizeFinding['id']>([
  'mcp-low-coverage',
  'mcp-project-scope',
  'mcp-deferral-off',
  'mcp-alwaysload-hygiene',
  'mcp-defer-threshold',
  'unused-agents',
  'unused-skills',
  'unused-commands',
])
const CURRENT_CONFIG_FINDING_IDS = new Set<OptimizeFinding['id']>([
  'mcp-deferral-off',
  'mcp-alwaysload-hygiene',
  'mcp-defer-threshold',
  'unused-agents',
  'unused-skills',
  'unused-commands',
])

/** All financial totals are observed scoped costs. Potential savings remain
 * unknown until a supported counterfactual and disjoint allocation exist. */
export function calculateOptimizePayload(
  projects: ProjectSummary[],
  scope: OverviewScope,
  setup: OptimizeSetup,
  now: Date,
): OptimizePayload {
  const dateRange = scopeDateRange(scope, now)
  const recentCutoffMs = now.getTime() - RECENT_WINDOW_MS
  const sessions = projects.flatMap(p => p.sessions)
  const behaviorProjects = selectSessions(projects, isHumanSession)
  const behaviorSessions = behaviorProjects.flatMap(p => p.sessions)
  const claudeProjects = selectSessions(
    projects,
    s => isClaudeSession(s) && (!scope.provider || scope.provider === 'claude'),
  )
  const claudeSessions = claudeProjects.flatMap(p => p.sessions)
  const scan = collectScanData(behaviorProjects, recentCutoffMs)
  const claudeScan = collectScanData(claudeProjects, recentCutoffMs)
  const coverage = aggregateMcpCoverage(claudeProjects)
  const setupObservedSessions = claudeSessions.filter(s => (s.mcpInventory?.length ?? 0) > 0)
  const findings: WasteFinding[] = []
  const evidenceById = new Map<OptimizeFinding['id'], SessionSummary[]>()

  function add(finding: WasteFinding | null, evidence: SessionSummary[] = []): void {
    if (!finding) return
    findings.push(finding)
    evidenceById.set(finding.id, evidence)
  }

  add(detectLowReadEditRatio(scan.steps))
  add(detectJunkReads(scan.steps, dateRange ?? undefined, now))
  add(detectDuplicateReads(scan.steps, dateRange ?? undefined, now))
  add(detectCacheBloat(scan.cacheEvents, behaviorProjects, dateRange ?? undefined, now))
  add(detectCapabilityReliability(behaviorProjects))
  const lowWorth = findLowWorthCandidates(behaviorProjects)
  const lowWorthByKey = new Map(lowWorth.map(candidate => [candidate.key ?? candidate.sessionId, candidate]))
  const lowWorthIds = new Set(lowWorthByKey.keys())
  const contextCandidates = findContextBloatCandidates(behaviorProjects).filter(
    c => !lowWorthIds.has(c.key ?? c.sessionId),
  )
  const contextIds = new Set(contextCandidates.map(c => c.key ?? c.sessionId))
  const exclusions = new Set([...lowWorthIds, ...contextIds, ...findYoungProjectFirstSessionIds(behaviorProjects)])
  add(
    detectLowWorthSessions(behaviorProjects),
    behaviorSessions.filter(s => lowWorthIds.has(sessionEvidenceKey(s))),
  )
  add(
    detectContextBloat(behaviorProjects, lowWorthIds),
    behaviorSessions.filter(s => contextIds.has(sessionEvidenceKey(s))),
  )
  add(detectSessionOutliers(behaviorProjects, exclusions))
  add(detectLowCacheReuse(projects))
  add(detectRecordedFailures(projects, false))
  add(detectRecordedFailures(projects, true))

  if (claudeSessions.length > 0) {
    add(detectMcpToolCoverage(claudeProjects, coverage))
    add(detectMcpProfileAdvisor(claudeProjects, coverage))
    add(detectMcpDeferralOff(claudeScan.steps, claudeProjects, setup))
    add(detectMcpAlwaysLoadHygiene(claudeProjects, setup, coverage))
    add(detectMcpDeferThreshold(claudeProjects, setup))
    add(detectGhostAgents(claudeScan.subagentTypes, setup.agents))
    add(detectGhostSkills(claudeScan.skills, setup.skills))
    add(detectGhostCommands(claudeScan.userMessages, setup.commands))
  }

  findings.sort((a, b) => urgencyScore(b) - urgencyScore(a))
  // Inventories establish setup observability. Current filesystem configuration
  // alone cannot establish the historical setup of selected sessions.
  const health =
    setupObservedSessions.length >= MCP_COVERAGE_MIN_SESSIONS &&
    setupObservedSessions.length >= claudeSessions.length / 2
      ? computeHealth(findings.filter(f => SETUP_FINDING_IDS.has(f.id) && !CURRENT_CONFIG_FINDING_IDS.has(f.id)))
      : null

  return {
    period: { start: dateRange?.start.toISOString() ?? null, end: dateRange?.end.toISOString() ?? null },
    summary: {
      healthScore: health?.score ?? null,
      healthGrade: health?.grade ?? null,
      findingCount: findings.length,
      periodCostUSD: projects.reduce((sum, p) => sum + p.totalCostUSD, 0),
      sessions: sessions.length,
      calls: projects.reduce((sum, p) => sum + p.totalApiCalls, 0),
      potentialSavingsTokens: null,
      potentialSavingsCostUSD: null,
      potentialSavingsPercent: null,
      setupCoverage: { eligibleSessions: claudeSessions.length, observedSessions: setupObservedSessions.length },
      behaviorSessions: behaviorSessions.length,
      excludedSidechainSessions: sessions.length - behaviorSessions.length,
    },
    findings: findings.map((f): OptimizeFinding => {
      const affectedKeys = f.affectedSessionKeys
      const affected = affectedKeys
        ? sessions.filter(s => affectedKeys.has(sessionEvidenceKey(s)))
        : (evidenceById.get(f.id) ?? [])
      const currentConfig = CURRENT_CONFIG_FINDING_IDS.has(f.id)
      const modeled =
        !f.quantity &&
        ![
          'low-worth-sessions',
          'context-heavy-sessions',
          'unused-agents',
          'unused-skills',
          'unused-commands',
          'build-folder-reads',
          'redundant-rereads',
        ].includes(f.id)
      let quantity = f.quantity ?? { value: f.tokensSaved, unit: 'tokens' as const }
      if (f.id === 'build-folder-reads' || f.id === 'redundant-rereads')
        quantity = { value: f.tokensSaved / AVG_TOKENS_PER_READ, unit: 'reads' }
      if (f.id === 'low-worth-sessions' || f.id === 'context-heavy-sessions')
        quantity = { value: affected.length, unit: 'sessions' }
      if (f.id.startsWith('unused-')) {
        const divisor = f.id === 'unused-commands' ? TOKENS_PER_COMMAND_DEF : TOKENS_PER_AGENT_DEF
        quantity = { value: f.tokensSaved / divisor, unit: 'definitions' }
      }
      const assumptions = [
        'Associated spend is the full scoped cost of sessions with supporting evidence, not an estimate of avoidable cost.',
        'Findings can overlap. Their quantities and associated spend must not be added together.',
      ]
      if (currentConfig)
        assumptions.push('Configuration is inspected now. Definition history and past prompt exposure are unavailable.')
      if (modeled) assumptions.push('Token quantity is a diagnostic model, not measured savings.')
      if (modeled && f.id.startsWith('mcp-'))
        assumptions.push(
          'MCP schema estimates assume 400 tokens per tool and, without inventory, 5 tools per server. Actual definitions and historical configuration are not captured.',
        )
      if (f.id === 'warmup-heavy')
        assumptions.push(
          'The baseline is the lower quartile of positive cache-write calls in this Scope. This does not compare matched tasks or models.',
        )
      if (f.id === 'read-edit-ratio')
        assumptions.push(
          'The 4:1 review threshold is a heuristic. Writes of new files are excluded and no savings are inferred.',
        )
      if (f.id === 'low-worth-sessions')
        assumptions.push(
          'Research and planning can be valuable without edits or captured Git commands. Missing commands do not prove missing delivery.',
        )
      if (f.id === 'context-heavy-sessions')
        assumptions.push(
          'Input/cache volume is observed without price weighting. The input-to-output threshold is a heuristic and task complexity is unknown.',
        )
      if (f.id === 'tool-failures' || f.id === 'interrupted-calls')
        assumptions.push(
          'Only explicit recorded flags are counted. Missing tool-result capture is unknown; absence of a finding does not establish error-free execution.',
        )
      if (f.id === 'low-cache-reuse')
        assumptions.push(
          'All-zero cache counters are unknown and excluded. Nonzero counters establish cache capture; the 10% threshold is diagnostic.',
        )
      const findingClass = SETUP_FINDING_IDS.has(f.id)
        ? 'setup'
        : [
              'cost-outliers',
              'low-worth-sessions',
              'context-heavy-sessions',
              'low-cache-reuse',
              'tool-failures',
              'interrupted-calls',
              'warmup-heavy',
            ].includes(f.id)
          ? 'information'
          : 'habit'
      return {
        id: f.id,
        title: f.title,
        explanation: f.explanation,
        severity: f.impact,
        trend: f.trend ?? null,
        findingClass,
        basis: modeled ? 'modeled' : 'observed',
        quantity,
        assumptions,
        affectedSessions: affected.map(s => ({
          key: sessionEvidenceKey(s),
          sourceId: s.sourceId ?? null,
          sessionId: s.sessionId,
          project: s.project,
          costUSD: s.totalCostUSD,
          reasons: [
            f.id === 'low-worth-sessions'
              ? (lowWorthByKey.get(sessionEvidenceKey(s))?.reasons.join(', ') ?? f.title)
              : f.title,
          ],
        })),
        associatedSpendUSD: affected.length > 0 ? affected.reduce((sum, s) => sum + s.totalCostUSD, 0) : null,
        tokensSaved: null,
        estimatedSavingsUSD: null,
        fix: f.fix,
      }
    }),
  }
}
