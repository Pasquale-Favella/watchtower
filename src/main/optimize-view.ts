import { existsSync, readFileSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename as pathBasename, join } from 'node:path'

import type { ProjectSummary, SessionSummary } from './pipeline/types.js'
import { overviewDateRange, periodWindowStart, type OverviewScope } from './overview.js'
import { buildSessionSummaries, groupSummariesIntoProjects } from './store/aggregate.js'
import type { LedgerStore } from './store/ledger.js'
import {
  optimizePayloadSchema,
  type ContextBloatCandidate,
  type FindingId,
  type HealthGrade,
  type Impact,
  type LowWorthCandidate,
  type OptimizeFinding,
  type OptimizePayload,
  type PasteDestination,
  type Trend,
  type WasteAction,
} from '../shared/schemas/optimize.js'

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

/** The Optimize section's scoped payload (ticket 28) — a read-only setup-health
 * grade, findings ranked by severity and trend, and clipboard-copyable fix
 * snippets. Exactly the same period / custom-range / provider scope as every
 * other section (shared `inScope`), then the 16 store-driven detectors run
 * against the scoped sessions.
 *
 * Deliberate design decisions, documented in code:
 * - 3 Claude-config detectors (unused-MCP-from-config, bloated CLAUDE.md,
 *   bash-limit) are ABSENT, not stubbed, per ticket 28 ÔÇö they depend on the
 *   `~/.claude/` config-source store-side decision that is still open.
 * - tool input is not persisted per call, so the read/ratio/ghost detectors
 *   walk `toolSequence` (tool name + `file_path`) and the parser's
 *   per-call `subagentTypes`/`skills` instead of raw tool_use inputs;
 * - the Claude Code version is not persisted per call, so detectCacheBloat
 *   and the deferral-gap detectors run without the version note / version
 *   gate (they degrade to the generic cause text);
 * - file paths are normalized to `/` so the junk/duplicate-read dir patterns
 *   match Windows paths too;
 * - user messages are capped at 500 chars for the ghost-command suggestion
 *   matcher (the ledger does not persist raw prompts);
 * - `now` is threaded through for deterministic, injectable recency/trends.
 */

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
const MCP_COVERAGE_LOW_THRESHOLD = 0.20
const MCP_COVERAGE_HIGH_IMPACT_TOKENS = 200_000
const MCP_PROFILE_MIN_PROJECTS = 3
const MCP_PROFILE_MIN_HOT_INVOCATIONS = 2
const MCP_PROFILE_HOT_INVOCATION_SHARE = 0.80
const MCP_PROFILE_MIN_COLD_LOADED_SESSIONS = 2
const MCP_PROFILE_HIGH_IMPACT_TOKENS = 200_000
const MCP_PROFILE_PREVIEW = 3
const CACHE_WRITE_MULTIPLIER = 1.25
const CACHE_READ_DISCOUNT = 0.10
const GHOST_AGENTS_HIGH_THRESHOLD = 5
const GHOST_AGENTS_MEDIUM_THRESHOLD = 2
const GHOST_SKILLS_HIGH_THRESHOLD = 10
const GHOST_SKILLS_MEDIUM_THRESHOLD = 5
const GHOST_COMMANDS_MEDIUM_THRESHOLD = 10
const MCP_NEW_CONFIG_GRACE_MS = 24 * 60 * 60 * 1000
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
const WORTH_IT_NO_EDIT_RECOVERY_FRACTION = 0.5
const WORTH_IT_MIN_RETRIES = 3
const WORTH_IT_RETRY_WITH_EDIT_MIN_RETRIES = 2
const WORTH_IT_PREVIEW = 5
const WORTH_IT_LOW_MAX_CANDIDATES = 2
const WORTH_IT_LOW_MAX_TOTAL_COST_USD = 10
const WORTH_IT_HIGH_MIN_CANDIDATES = 10
const WORTH_IT_HIGH_TOTAL_COST_USD = 50
const CAPABILITY_RELIABILITY_MIN_EDIT_TURNS = 5
const CAPABILITY_RELIABILITY_MIN_RETRY_TURNS = 3
const CAPABILITY_RELIABILITY_MIN_RETRY_RATE = 0.50
const CAPABILITY_RELIABILITY_RECOVERY_FRACTION = 0.50
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
const ALWAYSLOAD_STARTUP_CAP_SECONDS = 5
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
  'node_modules', '.git', 'dist', 'build', '__pycache__', '.next',
  '.nuxt', '.output', 'coverage', '.cache', '.tsbuildinfo',
  '.venv', 'venv', '.svn', '.hg',
]
const JUNK_PATTERN = new RegExp(`/(?:${JUNK_DIRS.join('|')})/`)

const SHELL_PROFILES = ['.zshrc', '.bashrc', '.bash_profile', '.profile']
const TOP_ITEMS_PREVIEW = 3
const GHOST_NAMES_PREVIEW = 5
const GHOST_CLEANUP_COMMANDS_LIMIT = 10
const OPTIMIZE_TEXT_CAP = 500

const READ_TOOL_NAMES = new Set(['Read', 'Grep', 'Glob', 'FileReadTool', 'GrepTool', 'GlobTool'])
const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'FileEditTool', 'FileWriteTool', 'NotebookEdit'])

// ============================================================================
// Types
// ============================================================================

interface WasteFinding extends Omit<OptimizeFinding, 'severity' | 'trend' | 'estimatedSavingsUSD'> {
  impact: Impact
  trend?: Trend
}

/** Flattened tool-call view of the scoped sessions: each `toolSequence` step
 * with its normalized file path and a recency flag (flattened from the
 * ledger's toolSequence, not a JSONL scan). */
type ScanStep = {
  name: string
  filePath?: string
  sessionId: string
  project: string
  recent: boolean
}

/** Per-call cache-creation event (version is empty
 * because the ledger does not persist the Claude Code version). */
type ApiCallMeta = {
  cacheCreationTokens: number
  version: string
  recent?: boolean
}

type ReportTurn = ProjectSummary['sessions'][number]['turns'][number]

type McpConfigEntry = {
  normalized: string
  original: string
  mtime: number
  alwaysLoadPaths: string[]
}

type DeferralEnvHit = { value: string; scope: string; path: string }

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

function readJsonFile(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
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

// ----------------------------------------------------------------------------
// ~/.claude config discovery (deferral-gap + ghost detectors). These touch the
// filesystem, with `homeDir` injectable for tests. The 3
// config-source detectors that would ALSO need this (unused-mcp, bloated
// CLAUDE.md, bash-limit) are absent per ticket 28.
// ----------------------------------------------------------------------------

export function loadMcpConfigs(projectCwds: Iterable<string>, home = homedir()): Map<string, McpConfigEntry> {
  const servers = new Map<string, McpConfigEntry>()
  const configPaths = [
    join(home, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.local.json'),
  ]
  for (const cwd of projectCwds) {
    configPaths.push(join(cwd, '.mcp.json'))
    configPaths.push(join(cwd, '.claude', 'settings.json'))
    configPaths.push(join(cwd, '.claude', 'settings.local.json'))
  }

  for (const p of configPaths) {
    if (!existsSync(p)) continue
    const config = readJsonFile(p)
    if (!config) continue
    let mtime = 0
    try { mtime = statSync(p).mtimeMs } catch {}
    const serversObj = (config.mcpServers ?? {}) as Record<string, unknown>
    for (const [name, rawEntry] of Object.entries(serversObj)) {
      const normalized = name.replace(/:/g, '_')
      const existing = servers.get(normalized)
      if (!existing || existing.mtime < mtime) {
        servers.set(normalized, { normalized, original: name, mtime, alwaysLoadPaths: existing?.alwaysLoadPaths ?? [] })
      }
      const entry = rawEntry as Record<string, unknown> | null
      if (entry && typeof entry === 'object' && entry.alwaysLoad === true) {
        servers.get(normalized)!.alwaysLoadPaths.push(p)
      }
    }
  }
  return servers
}

export function findDeferralEnvSetting(
  name: string,
  projectCwds: Iterable<string>,
  home = homedir(),
): DeferralEnvHit | null {
  const scopes: Array<{ scope: string; path: string }> = []
  for (const cwd of projectCwds) {
    scopes.push({ scope: 'project local settings', path: join(cwd, '.claude', 'settings.local.json') })
    scopes.push({ scope: 'project settings', path: join(cwd, '.claude', 'settings.json') })
  }
  scopes.push({ scope: 'user local settings', path: join(home, '.claude', 'settings.local.json') })
  scopes.push({ scope: 'user settings', path: join(home, '.claude', 'settings.json') })
  for (const { scope, path } of scopes) {
    if (!existsSync(path)) continue
    const config = readJsonFile(path)
    const env = config?.env as Record<string, unknown> | undefined
    const value = env?.[name]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return { value: String(value), scope, path }
    }
  }
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const linePattern = new RegExp(`^\\s*(?:export\\s+)?${escapedName}\\s*=\\s*['"]?([^'"\\s]+)['"]?`, 'm')
  for (const profile of SHELL_PROFILES) {
    const path = join(home, profile)
    if (!existsSync(path)) continue
    let content: string | null = null
    try { content = readFileSync(path, 'utf8') } catch {}
    if (content === null) continue
    const match = content.match(linePattern)
    if (match) return { value: match[1]!, scope: 'shell profile', path }
  }
  return null
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  try {
    const entries = await readdir(dir)
    return entries.filter(e => e.endsWith('.md')).map(e => e.replace(/\.md$/, ''))
  } catch {
    return []
  }
}

async function listSkillDirs(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return []
  try {
    const entries = await readdir(dir)
    const names: string[] = []
    for (const entry of entries) {
      if (existsSync(join(dir, entry, 'SKILL.md'))) names.push(entry)
    }
    return names
  } catch {
    return []
  }
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
            cacheEvents.push({ cacheCreationTokens: call.usage.cacheCreationInputTokens, version: '', recent })
          }
          for (const sub of call.subagentTypes ?? []) if (sub) subagentTypes.add(sub)
          for (const skill of call.skills ?? []) if (skill.trim()) skills.add(skill.trim())
          for (const stepArr of call.toolSequence ?? []) {
            for (const step of stepArr) {
              steps.push({
                name: step.tool,
                filePath: step.file ? normalizeSlashes(step.file) : undefined,
                sessionId: session.sessionId,
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

  for (const step of steps) {
    if (!isReadTool(step.name)) continue
    const filePath = step.filePath
    if (!filePath || !JUNK_PATTERN.test(filePath)) continue
    totalJunkReads++
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
  const dirList = sorted.slice(0, TOP_ITEMS_PREVIEW).map(([d, n]) => `${d}/ (${n}x)`).join(', ')
  const tokensSaved = totalJunkReads * AVG_TOKENS_PER_READ

  const detected = sorted.map(([d]) => d)
  const commonDefaults = ['node_modules', '.git', 'dist', '__pycache__']
  const extras = commonDefaults.filter(d => !dirCounts.has(d)).slice(0, Math.max(0, 6 - detected.length))
  const dirsToAvoid = [...detected, ...extras].join(', ')

  return {
    id: 'build-folder-reads',
    title: 'Claude is reading build/dependency folders',
    explanation: `Claude read into ${dirList} (${totalJunkReads} reads). These are generated or dependency directories, not your code. Tell Claude in CLAUDE.md to avoid them.`,
    impact: totalJunkReads > JUNK_READS_HIGH_THRESHOLD ? 'high' : totalJunkReads > JUNK_READS_MEDIUM_THRESHOLD ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'claude-md',
      label: 'Append to your project CLAUDE.md:',
      text: `Do not read or search files under these directories unless I explicitly ask: ${dirsToAvoid}.`,
    },
    trend,
  }
}

export function detectDuplicateReads(steps: ScanStep[], dateRange?: DateRange, now = new Date()): WasteFinding | null {
  const sessionFiles = new Map<string, Map<string, { count: number; recent: number }>>()

  for (const step of steps) {
    if (!isReadTool(step.name)) continue
    const filePath = step.filePath
    if (!filePath || JUNK_PATTERN.test(filePath)) continue
    const key = `${step.project}:${step.sessionId}`
    if (!sessionFiles.has(key)) sessionFiles.set(key, new Map())
    const fm = sessionFiles.get(key)!
    const entry = fm.get(filePath) ?? { count: 0, recent: 0 }
    entry.count++
    if (step.recent) entry.recent++
    fm.set(filePath, entry)
  }

  let totalDuplicates = 0
  let recentDuplicates = 0
  const fileDupes = new Map<string, number>()

  for (const fm of sessionFiles.values()) {
    for (const [file, entry] of fm) {
      if (entry.count <= 1) continue
      const extra = entry.count - 1
      totalDuplicates += extra
      if (entry.recent > 1) recentDuplicates += entry.recent - 1
      const name = fileBasename(file)
      fileDupes.set(name, (fileDupes.get(name) ?? 0) + extra)
    }
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
    title: 'Claude is re-reading the same files',
    explanation: `${totalDuplicates} redundant re-reads across sessions. Top repeats: ${worst}. Each re-read loads the same content into context again.`,
    impact: totalDuplicates > DUPLICATE_READS_HIGH_THRESHOLD ? 'high' : totalDuplicates > DUPLICATE_READS_MEDIUM_THRESHOLD ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'prompt',
      label: 'Point Claude at exact locations in your prompt, for example:',
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
  for (const step of steps) {
    if (READ_TOOL_NAMES.has(step.name)) {
      reads++
      if (step.recent) recentReads++
    } else if (EDIT_TOOL_NAMES.has(step.name)) {
      edits++
      if (step.recent) recentEdits++
    }
  }

  if (edits < MIN_EDITS_FOR_RATIO) return null
  const ratio = reads / edits
  if (ratio >= HEALTHY_READ_EDIT_RATIO) return null

  const impact: Impact = ratio < LOW_RATIO_HIGH_THRESHOLD ? 'high' : ratio < LOW_RATIO_MEDIUM_THRESHOLD ? 'medium' : 'low'
  const extraReadsNeeded = Math.max(Math.round(edits * HEALTHY_READ_EDIT_RATIO) - reads, 0)
  const tokensSaved = extraReadsNeeded * AVG_TOKENS_PER_READ

  let trend: Trend | 'resolved' = 'active'
  if (recentEdits >= MIN_EDITS_FOR_RATIO) {
    const recentRatio = recentReads / recentEdits
    if (recentRatio >= HEALTHY_READ_EDIT_RATIO) trend = 'resolved'
    else if (recentRatio > ratio * (1 / IMPROVING_THRESHOLD)) trend = 'improving'
  }
  if (trend === 'resolved') return null

  return {
    id: 'read-edit-ratio',
    title: 'Claude edits more than it reads',
    explanation: `Claude made ${reads} reads and ${edits} edits (ratio ${ratio.toFixed(1)}:1). A healthy ratio is ${HEALTHY_READ_EDIT_RATIO}+ reads per edit. Editing without reading leads to retries and wasted tokens.`,
    impact,
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'claude-md',
      label: 'Add to your CLAUDE.md:',
      text: 'Before editing any file, read it first. Before modifying a function, grep for all callers. Research before you edit.',
    },
    trend,
  }
}

// ============================================================================
// Cache-warmup detector
// ============================================================================

const DEFAULT_CACHE_BASELINE_TOKENS = 50_000
const CACHE_BASELINE_QUANTILE = 0.25
const CACHE_BLOAT_MULTIPLIER = 1.4

function computeBudgetAwareCacheBaseline(projects: ProjectSummary[]): number {
  const sessions = projects.flatMap(p => p.sessions)
  if (sessions.length === 0) return DEFAULT_CACHE_BASELINE_TOKENS
  const cacheWrites = sessions.map(s => s.totalCacheWriteTokens).filter(n => n > 0)
  if (cacheWrites.length < MIN_API_CALLS_FOR_CACHE) return DEFAULT_CACHE_BASELINE_TOKENS
  const sorted = cacheWrites.sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * CACHE_BASELINE_QUANTILE)] || DEFAULT_CACHE_BASELINE_TOKENS
}

export function detectCacheBloat(apiCalls: ApiCallMeta[], projects: ProjectSummary[], dateRange?: DateRange, now = new Date()): WasteFinding | null {
  if (apiCalls.length < MIN_API_CALLS_FOR_CACHE) return null

  const sorted = apiCalls.map(c => c.cacheCreationTokens).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const baseline = computeBudgetAwareCacheBaseline(projects)
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
    title: 'Session warmup is unusually large',
    explanation: `Median cache_creation per call is ${formatTokens(median)} tokens, about ${formatTokens(excess)} above your baseline of ${formatTokens(baseline)}.`,
    impact: excess > CACHE_EXCESS_HIGH_THRESHOLD ? 'high' : 'medium',
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'shell-config',
      label: 'Check for recent Claude Code updates or heavy MCP/skill additions. As a workaround (not officially supported), add to ~/.zshrc or ~/.bashrc:',
      text: 'export ANTHROPIC_CUSTOM_HEADERS=\'User-Agent: claude-cli/2.1.98 (external, sdk-cli)\'',
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
    const unusedTools = Array.from(acc.inventory).filter(t => !invokedInInventory.has(t)).sort()
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
      let loaded = false
      for (const fqn of session.mcpInventory ?? []) {
        const seg = fqn.split('__')[1]
        if (seg && serverSet.has(seg)) { loaded = true; break }
      }
      if (!loaded) continue

      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          if (call.usage.cacheCreationInputTokens > 0) {
            cacheWriteTokens += Math.min(totalUnusedSchemaTokens, call.usage.cacheCreationInputTokens)
          }
          if (call.usage.cacheReadInputTokens > 0) {
            cacheReadTokens += Math.min(totalUnusedSchemaTokens, call.usage.cacheReadInputTokens)
          }
        }
      }
    }
  }

  const effectiveInputTokens = cacheWriteTokens * CACHE_WRITE_MULTIPLIER + cacheReadTokens * CACHE_READ_DISCOUNT
  return { cacheWriteTokens, cacheReadTokens, effectiveInputTokens }
}

export function detectMcpToolCoverage(
  projects: ProjectSummary[],
  coverage = aggregateMcpCoverage(projects),
): WasteFinding | null {
  if (coverage.length === 0) return null

  const flagged = coverage.filter(c =>
    c.toolsAvailable > MCP_COVERAGE_MIN_TOOLS
    && c.loadedSessions >= MCP_COVERAGE_MIN_SESSIONS
    && c.coverageRatio < MCP_COVERAGE_LOW_THRESHOLD,
  )
  if (flagged.length === 0) return null

  flagged.sort((a, b) => (b.toolsAvailable - b.toolsInvoked) - (a.toolsAvailable - a.toolsInvoked))

  const lines: string[] = []
  const removeCommands: string[] = []
  const unusedCountsByServer: Record<string, number> = {}
  const flaggedServers: string[] = []

  for (const c of flagged) {
    unusedCountsByServer[c.server] = c.toolsAvailable - c.toolsInvoked
    flaggedServers.push(c.server)
    const pct = Math.round(c.coverageRatio * 100)
    lines.push(
      `${c.server}: ${c.toolsInvoked}/${c.toolsAvailable} tools used (${pct}% coverage) across ${c.loadedSessions} session${c.loadedSessions === 1 ? '' : 's'}`,
    )
    removeCommands.push(`claude mcp remove '${c.server}'`)
  }

  const cost = estimateMcpSchemaCost(unusedCountsByServer, projects, flaggedServers)
  const tokensSaved = Math.round(cost.effectiveInputTokens)
  const impact: Impact = tokensSaved >= MCP_COVERAGE_HIGH_IMPACT_TOKENS
    ? 'high'
    : flagged.length >= UNUSED_MCP_HIGH_THRESHOLD
      ? 'high'
      : 'medium'

  return {
    id: 'mcp-low-coverage',
    title: `${flagged.length} MCP server${flagged.length === 1 ? '' : 's'} with low tool coverage`,
    explanation:
      `Schema for unused tools is loaded into the system prompt every session and ` +
      `carried in the cached prefix on every turn. ` +
      `${lines.join('; ')}.`,
    impact,
    tokensSaved,
    fix: {
      type: 'command',
      label: flagged.length === 1
        ? 'Remove the underused server, or trim its tools in your MCP config:'
        : 'Remove underused servers, or trim their tools in your MCP config:',
      text: removeCommands.join('\n'),
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
      .filter(c =>
        c.toolsAvailable > MCP_COVERAGE_MIN_TOOLS
        && c.loadedSessions >= MCP_COVERAGE_MIN_SESSIONS
        && c.coverageRatio < MCP_COVERAGE_LOW_THRESHOLD,
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

  const effectiveInputTokens = cacheWriteTokens * CACHE_WRITE_MULTIPLIER + cacheReadTokens * CACHE_READ_DISCOUNT
  return { cacheWriteTokens, cacheReadTokens, effectiveInputTokens }
}

function collectMcpProjectProfiles(
  projects: ProjectSummary[],
  coverage: McpServerCoverage[],
): McpProfileCandidate[] {
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

    loaded.sort((a, b) =>
      b.invocations - a.invocations
      || b.loadedSessions - a.loadedSessions
      || a.projectPath.localeCompare(b.projectPath),
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

  candidates.sort((a, b) =>
    b.estimatedTokensSaved - a.estimatedTokensSaved
    || b.coldProjects.length - a.coldProjects.length
    || b.loadedSessions - a.loadedSessions
    || a.server.localeCompare(b.server),
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
  const impact: Impact = tokensSaved >= MCP_PROFILE_HIGH_IMPACT_TOKENS
    || candidates.length >= UNUSED_MCP_HIGH_THRESHOLD
    ? 'high'
    : 'medium'

  return {
    id: 'mcp-project-scope',
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
          const cold = candidate.coldProjects.slice(0, 3).map(p => p.projectPath).join(', ')
          return `- Keep ${candidate.server} available for ${hot}; remove or project-scope it away from ${cold}. Re-add it only in projects that actually need it.`
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

function collectReliabilityCapabilities(turn: ProjectSummary['sessions'][number]['turns'][number]): Map<string, CapabilityRef> {
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
  return Math.round(turn.assistantCalls.reduce((sum, call) =>
    sum
    + call.usage.inputTokens
    + call.usage.outputTokens
    + call.usage.cacheCreationInputTokens * CACHE_WRITE_MULTIPLIER
    + call.usage.cacheReadInputTokens * CACHE_READ_DISCOUNT,
  0))
}

function reliabilityTurnKey(
  project: ProjectSummary,
  session: ProjectSummary['sessions'][number],
  turn: ProjectSummary['sessions'][number]['turns'][number],
  turnIndex: number,
): string {
  return `${project.projectPath || project.project}:${session.sessionId}:${turn.timestamp}:${turnIndex}`
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
        const turnKey = reliabilityTurnKey(project, session, turn, turnIndex)
        const recoverableTokens = turn.retries > 0
          ? Math.round(turnTokens * CAPABILITY_RELIABILITY_RECOVERY_FRACTION)
          : 0

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

  candidates.sort((a, b) =>
    b.retryRate - a.retryRate
    || b.retries - a.retries
    || b.tokensSaved - a.tokensSaved
    || a.kind.localeCompare(b.kind)
    || a.name.localeCompare(b.name)
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

        const key = reliabilityTurnKey(project, session, turn, turnIndex)
        const tokens = Math.round(turnEffectiveTokenTotal(turn) * CAPABILITY_RELIABILITY_RECOVERY_FRACTION)
        uniqueRetryTurnSavings.set(key, Math.max(uniqueRetryTurnSavings.get(key) ?? 0, tokens))
      }
    }
  }

  const tokensSaved = Array.from(uniqueRetryTurnSavings.values()).reduce((sum, tokens) => sum + tokens, 0)
  const preview = candidates.slice(0, CAPABILITY_RELIABILITY_PREVIEW)
  const list = preview.map(c => {
    const percent = Math.round(c.retryRate * 100)
    const projects = c.projects.length > 1 ? ` across ${c.projects.length} projects` : ` in ${c.projects[0] ?? 'one project'}`
    return `${formatCapabilityKind(c.kind)} ${c.name}: ${c.retryTurns}/${c.editTurns} edit turns retried (${percent}%), ${c.retries} retries${projects}`
  }).join('; ')
  const extra = candidates.length > preview.length ? `; +${candidates.length - preview.length} more` : ''

  const names = preview
    .map(c => `${formatCapabilityKind(c.kind)} ${c.name}`)
    .join(', ')

  let impact: Impact
  if (candidates.length >= CAPABILITY_RELIABILITY_HIGH_MIN_CANDIDATES || tokensSaved >= CAPABILITY_RELIABILITY_HIGH_IMPACT_TOKENS) {
    impact = 'high'
  } else if (candidates.length <= CAPABILITY_RELIABILITY_LOW_MAX_CANDIDATES && tokensSaved < CAPABILITY_RELIABILITY_LOW_MAX_TOKENS) {
    impact = 'low'
  } else {
    impact = 'medium'
  }

  const kindSet = new Set(candidates.map(c => c.kind))
  const noun = kindSet.size === 1
    ? (kindSet.has('mcp') ? 'MCP server' : 'skill')
    : 'MCP/skill capability'
  const pluralNoun = noun === 'MCP/skill capability' ? 'MCP/skill capabilities' : `${noun}s`
  const verb = candidates.length === 1 ? 'correlates' : 'correlate'

  return {
    id: 'retry-heavy-capabilities',
    title: `${candidates.length} ${candidates.length === 1 ? noun : pluralNoun} ${verb} with retry-heavy edits`,
    explanation: `Edit turns using these capabilities are retry-heavy: ${list}${extra}. This is a correlation report, not proof of causation; compare the retry-heavy turns with one-shot turns before changing MCP scope or skill instructions.`,
    impact,
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'prompt',
      label: 'Ask Claude to audit the retry-heavy capability before changing config:',
      text: `Investigate these retry-correlated capabilities: ${names}. Compare edit turns with retries against one-shot edit turns, identify whether the MCP server or skill actually caused rework, then propose a scoped MCP config or skill-instruction change with session evidence. Do not remove a capability solely because it appears in this report.`,
    },
  }
}

// ============================================================================
// MCP deferral-gap detectors (detection only, no apply plans ÔÇö ticket 28)
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
  projectCwds: Set<string>,
  home: string,
): { cause: string; fix: WasteAction } {
  if (enableToolSearch && isEnvValueFalse(enableToolSearch.value)) {
    return {
      cause: `Cause: ${ENABLE_TOOL_SEARCH_VAR}=${enableToolSearch.value} is set in ${enableToolSearch.scope} (${shortHomePath(enableToolSearch.path, home)}), forcing all tool definitions upfront.`,
      fix: {
        type: 'paste',
        destination: 'prompt',
        label: 'Ask Claude to remove the stale override:',
        text: `Remove the ${ENABLE_TOOL_SEARCH_VAR}=${enableToolSearch.value} setting from ${enableToolSearch.path}. Tool search is on by default on first-party endpoints, so deleting the override re-enables MCP tool deferral.`,
      },
    }
  }
  const baseUrl = findDeferralEnvSetting(ANTHROPIC_BASE_URL_VAR, projectCwds, home)
  if (baseUrl && !isFirstPartyBaseUrl(baseUrl.value)) {
    return {
      cause: `Cause: ${ANTHROPIC_BASE_URL_VAR} points at a non-first-party host in ${baseUrl.scope} (${shortHomePath(baseUrl.path, home)}). Tool deferral silently auto-disables behind proxies because most don't forward tool_reference blocks; whether this proxy can is unknown.`,
      fix: {
        type: 'paste',
        destination: 'shell-config',
        label: `Verify your proxy forwards tool_reference blocks first (an explicit override fails on proxies that don't), then force tool search back on with:`,
        text: `export ${ENABLE_TOOL_SEARCH_VAR}=true`,
      },
    }
  }
  const vertex = findDeferralEnvSetting(CLAUDE_CODE_USE_VERTEX_VAR, projectCwds, home)
  if (vertex && !isEnvValueFalse(vertex.value)) {
    return {
      cause: `Cause: ${CLAUDE_CODE_USE_VERTEX_VAR} is set in ${vertex.scope} (${shortHomePath(vertex.path, home)}), and tool search is disabled by default on Vertex AI.`,
      fix: {
        type: 'paste',
        destination: 'shell-config',
        label: 'Opt in to tool search on Vertex (disabled by default there):',
        text: `export ${ENABLE_TOOL_SEARCH_VAR}=true`,
      },
    }
  }
  // The desktop report does not persist the Claude Code version per call, so
  // the "every observed version predates v2.1.7" cause is skipped.
  if (enableToolSearch) {
    return {
      cause: `Cause: none determinable ÔÇö ${ENABLE_TOOL_SEARCH_VAR}=${enableToolSearch.value} is already set in ${enableToolSearch.scope} (${shortHomePath(enableToolSearch.path, home)}), yet transcripts show no deferral activity.`,
      fix: {
        type: 'paste',
        destination: 'prompt',
        label: 'The override is already on; ask Claude to investigate why deferral is still inactive:',
        text: `${ENABLE_TOOL_SEARCH_VAR}=${enableToolSearch.value} is set in ${enableToolSearch.path}, but sessions show no ToolSearch calls and no deferred-tool inventory. Check whether requests pass through a proxy that strips tool_reference blocks and whether the running Claude Code version supports tool search.`,
      },
    }
  }
  return {
    cause: `Cause: none determinable from config ÔÇö no disabling override, proxy, or Vertex setting found.`,
    fix: {
      type: 'paste',
      destination: 'shell-config',
      label: 'Deferral is on by default on first-party endpoints; to force it explicitly, add:',
      text: `export ${ENABLE_TOOL_SEARCH_VAR}=true`,
    },
  }
}

export function detectMcpDeferralOff(
  steps: ScanStep[],
  projects: ProjectSummary[],
  projectCwds: Set<string>,
  home = homedir(),
): WasteFinding | null {
  if (steps.some(s => s.name === TOOL_SEARCH_TOOL_NAME)) return null
  if (anySessionHasMcpInventory(projects)) return null

  const configured = loadMcpConfigs(projectCwds, home)
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

  const enableToolSearch = findDeferralEnvSetting(ENABLE_TOOL_SEARCH_VAR, projectCwds, home)
  if (enableToolSearch && /^auto(?::\d+)?$/.test(enableToolSearch.value)) return null

  const perServerSchemaTokens = TOOLS_PER_MCP_SERVER * TOKENS_PER_MCP_TOOL
  const perSessionSchemaTokens = servers.size * perServerSchemaTokens
  const tokensSaved = perSessionSchemaTokens * affectedSessions
  const callRate = affectedSessions > 0 ? invocations / affectedSessions : 0
  const callRateText = callRate.toFixed(1)

  const evidence =
    `~${formatTokens(perSessionSchemaTokens)} tokens of MCP tool schema ` +
    `(${servers.size} server${servers.size === 1 ? '' : 's'} at ~${formatTokens(perServerSchemaTokens)} tokens/server) sit in the prompt prefix of ` +
    `${affectedSessions} session${affectedSessions === 1 ? '' : 's'} at ` +
    `${callRateText} MCP call${callRateText === '1.0' ? '' : 's'}/session, with zero ToolSearch calls ` +
    `and no deferred-tool inventory observed ÔÇö tool deferral appears inactive. ` +
    `Deferral would move ~all of that schema out of the prefix.`

  const { cause, fix } = attributeDeferralOffCause(enableToolSearch, projectCwds, home)

  return {
    id: 'mcp-deferral-off',
    title: 'MCP tool deferral appears inactive',
    explanation: `${evidence} ${cause}`,
    impact: tokensSaved >= DEFERRAL_OFF_HIGH_IMPACT_TOKENS ? 'high' : 'medium',
    tokensSaved,
    fix,
  }
}

export function detectMcpAlwaysLoadHygiene(
  projects: ProjectSummary[],
  projectCwds: Set<string>,
  mcpCoverage = aggregateMcpCoverage(projects),
  home = homedir(),
): WasteFinding | null {
  const configured = loadMcpConfigs(projectCwds, home)
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
    lines.push(`${entry.original}: ${invocations} call${invocations === 1 ? '' : 's'} across ${totalSessions} session${totalSessions === 1 ? '' : 's'}`)
    fixLines.push(`- Remove "alwaysLoad": true from ${entry.original} in ${entry.alwaysLoadPaths.map(p => shortHomePath(p, home)).join(', ')}.`)
  }
  if (lines.length === 0) return null

  return {
    id: 'mcp-alwaysload-hygiene',
    title: `${lines.length} alwaysLoad MCP server${lines.length === 1 ? '' : 's'} rarely used`,
    explanation:
      `These servers are pinned with alwaysLoad, so their tool schemas sit in every session's prefix ` +
      `despite deferral being available, and session startup blocks on each server's connection ` +
      `(up to ${ALWAYSLOAD_STARTUP_CAP_SECONDS}s). Usage doesn't justify the pin: ${lines.join('; ')}.`,
    impact: tokensSaved >= ALWAYSLOAD_HIGH_IMPACT_TOKENS ? 'high' : 'medium',
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'prompt',
      label: 'Ask Claude to unpin the rarely-used servers (tool search still discovers their tools on demand):',
      text: fixLines.join('\n'),
    },
  }
}

export function detectMcpDeferThreshold(
  projects: ProjectSummary[],
  projectCwds: Set<string>,
  home = homedir(),
): WasteFinding | null {
  const setting = findDeferralEnvSetting(ENABLE_TOOL_SEARCH_VAR, projectCwds, home)
  if (!setting) return null
  const match = /^auto(?::(\d+))?$/.exec(setting.value)
  if (!match) return null
  const percent = match[1] !== undefined
    ? Math.min(DEFER_THRESHOLD_MAX_PERCENT, parseInt(match[1], 10))
    : DEFER_THRESHOLD_DEFAULT_PERCENT

  if (anySessionHasMcpInventory(projects)) return null

  const configured = loadMcpConfigs(projectCwds, home)
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
    title: 'MCP tool search auto threshold never triggers',
    explanation:
      `${ENABLE_TOOL_SEARCH_VAR}=${setting.value} is set in ${setting.scope} (${shortHomePath(setting.path, home)}), ` +
      `deferring MCP tool definitions only when they exceed ${percent}% of the ${formatTokens(DEFER_THRESHOLD_CONTEXT_WINDOW_TOKENS)}-token context window ` +
      `(~${formatTokens(thresholdTokens)} tokens). Your estimated ~${formatTokens(defsPerSession)} tokens of definitions per session fit under that, ` +
      `so every tool still loads upfront in all ${totalSessions} session${totalSessions === 1 ? '' : 's'}.`,
    impact: tokensSaved >= DEFER_THRESHOLD_MEDIUM_IMPACT_TOKENS ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'prompt',
      label: 'Ask Claude to tighten the auto threshold:',
      text: removeOverride
        ? `Remove the ${ENABLE_TOOL_SEARCH_VAR}=${setting.value} override from ${setting.path}; the default auto threshold (${DEFER_THRESHOLD_DEFAULT_PERCENT}%) already defers this volume of tool definitions.`
        : `In ${setting.path}, change ${ENABLE_TOOL_SEARCH_VAR}=${setting.value} to ${ENABLE_TOOL_SEARCH_VAR}=auto:${recommendedPercent} so ~${formatTokens(defsPerSession)} tokens of MCP tool definitions per session are deferred instead of loaded upfront.`,
    },
  }
}

// ============================================================================
// Ghost-agent/skill/command detectors
// ============================================================================

export async function detectGhostAgents(subagentTypes: Iterable<string>, home = homedir()): Promise<WasteFinding | null> {
  const defined = await listMarkdownFiles(join(home, '.claude', 'agents'))
  if (defined.length === 0) return null

  const invoked = new Set(subagentTypes)
  const ghosts = defined.filter(name => !invoked.has(name))
  if (ghosts.length === 0) return null

  const tokensSaved = ghosts.length * TOKENS_PER_AGENT_DEF
  const list = ghosts.slice(0, GHOST_NAMES_PREVIEW).join(', ') + (ghosts.length > GHOST_NAMES_PREVIEW ? `, +${ghosts.length - GHOST_NAMES_PREVIEW} more` : '')

  return {
    id: 'unused-agents',
    title: `${ghosts.length} custom agent${ghosts.length > 1 ? 's' : ''} you never use`,
    explanation: `Defined in ~/.claude/agents/ but never invoked in this period: ${list}. Each adds ~${TOKENS_PER_AGENT_DEF} tokens to the Task tool schema on every session.`,
    impact: ghosts.length >= GHOST_AGENTS_HIGH_THRESHOLD ? 'high' : ghosts.length >= GHOST_AGENTS_MEDIUM_THRESHOLD ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'command',
      label: `Archive unused agent${ghosts.length > 1 ? 's' : ''}:`,
      text: ghosts.slice(0, GHOST_CLEANUP_COMMANDS_LIMIT).map(name => `mv ~/.claude/agents/${name}.md ~/.claude/agents/.archived/`).join('\n'),
    },
  }
}

export async function detectGhostSkills(skills: Iterable<string>, home = homedir()): Promise<WasteFinding | null> {
  const defined = await listSkillDirs(join(home, '.claude', 'skills'))
  if (defined.length === 0) return null

  const invoked = new Set(skills)
  const ghosts = defined.filter(name => !invoked.has(name))
  if (ghosts.length === 0) return null

  const tokensSaved = ghosts.length * TOKENS_PER_SKILL_DEF
  const list = ghosts.slice(0, GHOST_NAMES_PREVIEW).join(', ') + (ghosts.length > GHOST_NAMES_PREVIEW ? `, +${ghosts.length - GHOST_NAMES_PREVIEW} more` : '')

  return {
    id: 'unused-skills',
    title: `${ghosts.length} skill${ghosts.length > 1 ? 's' : ''} you never use`,
    explanation: `In ~/.claude/skills/ but not invoked this period: ${list}. Each adds ~${TOKENS_PER_SKILL_DEF} tokens of metadata to every session.`,
    impact: ghosts.length >= GHOST_SKILLS_HIGH_THRESHOLD ? 'high' : ghosts.length >= GHOST_SKILLS_MEDIUM_THRESHOLD ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'command',
      label: `Archive unused skill${ghosts.length > 1 ? 's' : ''}:`,
      text: ghosts.slice(0, GHOST_CLEANUP_COMMANDS_LIMIT).map(name => `mv ~/.claude/skills/${name} ~/.claude/skills/.archived/`).join('\n'),
    },
  }
}

const COMMAND_PATTERN = /<command-name>([^<]+)<\/command-name>|(?:^|\s)\/([a-zA-Z][\w-]*)/gm

export async function detectGhostCommands(userMessages: string[], home = homedir()): Promise<WasteFinding | null> {
  const defined = await listMarkdownFiles(join(home, '.claude', 'commands'))
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
  const list = ghosts.slice(0, GHOST_NAMES_PREVIEW).join(', ') + (ghosts.length > GHOST_NAMES_PREVIEW ? `, +${ghosts.length - GHOST_NAMES_PREVIEW} more` : '')

  return {
    id: 'unused-commands',
    title: `${ghosts.length} slash command${ghosts.length > 1 ? 's' : ''} you never use`,
    explanation: `In ~/.claude/commands/ but not referenced this period: ${list}. Each adds ~${TOKENS_PER_COMMAND_DEF} tokens of definition per session.`,
    impact: ghosts.length >= GHOST_COMMANDS_MEDIUM_THRESHOLD ? 'medium' : 'low',
    tokensSaved,
    fix: {
      type: 'command',
      label: `Archive unused command${ghosts.length > 1 ? 's' : ''}:`,
      text: ghosts.slice(0, GHOST_CLEANUP_COMMANDS_LIMIT).map(name => `mv ~/.claude/commands/${name}.md ~/.claude/commands/.archived/`).join('\n'),
    },
  }
}

// ============================================================================
// Low-worth / context-bloat / session-outlier detectors
// ============================================================================

function sessionTokenTotal(session: SessionSummary): number {
  return session.totalInputTokens
    + session.totalOutputTokens
    + session.totalCacheReadTokens
    + session.totalCacheWriteTokens
}

function sessionEffectiveContextTokens(session: SessionSummary): number {
  return session.totalInputTokens
    + session.totalCacheReadTokens * CACHE_READ_DISCOUNT
    + session.totalCacheWriteTokens * CACHE_WRITE_MULTIPLIER
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
  return Object.values(session.categoryBreakdown).some(category =>
    category.turns > 0
    || category.costUSD > 0
    || category.retries > 0
    || category.editTurns > 0
    || category.oneShotTurns > 0
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

function sessionTotalTurns(session: SessionSummary): number {
  if (hasCategoryBreakdownData(session)) {
    return Object.values(session.categoryBreakdown).reduce((sum, c) => sum + c.turns, 0)
  }
  return session.turns.length
}

function estimateLowWorthRecoverableTokens(session: SessionSummary, editTurns: number, retries: number): number {
  const tokens = sessionTokenTotal(session)
  if (editTurns === 0) return Math.round(tokens * WORTH_IT_NO_EDIT_RECOVERY_FRACTION)
  const totalTurns = sessionTotalTurns(session)
  if (totalTurns === 0) return 0
  const fraction = Math.min(1, Math.max(0, retries / totalTurns))
  return Math.round(tokens * fraction)
}

export const LOW_WORTH_OPENER = 'Before continuing, name the deliverable in one sentence (PR title, file changed, command output you expect). Stop and check with me if (a) you spend more than 10 minutes without an edit, or (b) the same approach fails twice. Do not retry past two attempts on any single fix.'
export const CONTEXT_HEAVY_OPENER = 'Start fresh before continuing. Use only the current goal, the relevant files, the failing command/output, and the constraints below. Restate the working context in under 10 bullets before editing.'

export function findLowWorthCandidates(projects: ProjectSummary[]): LowWorthCandidate[] {
  const candidates: LowWorthCandidate[] = []

  for (const project of projects) {
    for (const session of project.sessions) {
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
      if (
        editTurns > 0
        && oneShotTurns === 0
        && retries >= WORTH_IT_RETRY_WITH_EDIT_MIN_RETRIES
      ) {
        reasons.push('no one-shot edit turns')
      }

      if (reasons.length === 0) continue

      candidates.push({
        project: project.project,
        sessionId: session.sessionId,
        date: session.firstTimestamp.slice(0, 10),
        cost: session.totalCostUSD,
        tokens: estimateLowWorthRecoverableTokens(session, editTurns, retries),
        reasons,
      })
    }
  }

  candidates.sort((a, b) =>
    b.cost - a.cost
    || a.date.localeCompare(b.date)
    || a.project.localeCompare(b.project)
    || a.sessionId.localeCompare(b.sessionId)
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
    title: `${candidates.length} possibly low-worth expensive session${candidates.length === 1 ? '' : 's'}`,
    explanation: `Sessions with meaningful spend but weak delivery signals: ${list}${extra}. This is a review candidate, not proof of waste: Watchtower flags missing edit turns, repeated retries, and sessions without git delivery commands so you can decide whether the work was worth its cost before it becomes a habit.`,
    impact,
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'session-opener',
      label: 'Paste at the start of your NEXT expensive thread (one-time, do not add to CLAUDE.md):',
      text: LOW_WORTH_OPENER,
    },
  }
}

export function findContextBloatCandidates(projects: ProjectSummary[]): ContextBloatCandidate[] {
  const candidates: ContextBloatCandidate[] = []

  for (const project of projects) {
    const sessions = [...project.sessions].sort((a, b) =>
      new Date(a.firstTimestamp).getTime() - new Date(b.firstTimestamp).getTime()
    )
    let previousInputTokens: number | null = null
    let previousTimestampMs: number | null = null

    for (const session of sessions) {
      const inputTokens = sessionEffectiveContextTokens(session)
      const outputTokens = session.totalOutputTokens
      const ratio = inputTokens / Math.max(outputTokens, 1)
      const currentMs = new Date(session.firstTimestamp).getTime()
      const gapMs = previousTimestampMs !== null ? currentMs - previousTimestampMs : null
      const growthRatio = previousInputTokens !== null
        && previousInputTokens > 0
        && gapMs !== null
        && gapMs <= CONTEXT_BLOAT_GROWTH_MAX_GAP_MS
        ? inputTokens / previousInputTokens
        : null

      previousInputTokens = inputTokens
      previousTimestampMs = currentMs

      if (inputTokens < CONTEXT_BLOAT_MIN_INPUT_TOKENS) continue
      if (ratio < CONTEXT_BLOAT_MIN_RATIO) continue

      candidates.push({
        project: project.project,
        sessionId: session.sessionId,
        date: session.firstTimestamp.slice(0, 10),
        effectiveInputTokens: inputTokens,
        outputTokens,
        ratio,
        excessInputTokens: Math.max(0, inputTokens - outputTokens * CONTEXT_BLOAT_TARGET_RATIO),
        growthRatio,
      })
    }
  }

  candidates.sort((a, b) =>
    b.excessInputTokens - a.excessInputTokens
    || a.date.localeCompare(b.date)
    || a.project.localeCompare(b.project)
    || a.sessionId.localeCompare(b.sessionId)
  )
  return candidates
}

export function detectContextBloat(projects: ProjectSummary[], excludedSessionIds?: ReadonlySet<string>): WasteFinding | null {
  const candidates = findContextBloatCandidates(projects)
    .filter(c => !excludedSessionIds?.has(c.sessionId))
  if (candidates.length === 0) return null

  const preview = candidates.slice(0, CONTEXT_BLOAT_PREVIEW)
  const list = preview
    .map(c => {
      const growth = c.growthRatio !== null && c.growthRatio >= CONTEXT_BLOAT_GROWTH_RATIO
        ? `, ${c.growthRatio.toFixed(1)}x previous session input`
        : ''
      return `${c.project}/${c.sessionId} on ${c.date}: ${formatTokens(c.effectiveInputTokens)} effective input/cache vs ${formatTokens(c.outputTokens)} output (${formatContextRatio(c.ratio)}:1${growth})`
    })
    .join('; ')
  const extra = candidates.length > preview.length ? `; +${candidates.length - preview.length} more` : ''
  const tokensSaved = Math.round(candidates.reduce((sum, c) => sum + c.excessInputTokens, 0))
  const totalInputTokens = candidates.reduce((sum, c) => sum + c.effectiveInputTokens, 0)

  let impact: Impact
  if (candidates.length >= CONTEXT_BLOAT_HIGH_MIN_CANDIDATES || totalInputTokens >= CONTEXT_BLOAT_HIGH_INPUT_TOKENS) {
    impact = 'high'
  } else if (candidates.length <= CONTEXT_BLOAT_LOW_MAX_CANDIDATES && totalInputTokens < CONTEXT_BLOAT_LOW_INPUT_TOKENS) {
    impact = 'low'
  } else {
    impact = 'medium'
  }

  return {
    id: 'context-heavy-sessions',
    title: `${candidates.length} context-heavy session${candidates.length === 1 ? '' : 's'}`,
    explanation: `Effective input/cache tokens swamp output in these sessions: ${list}${extra}. This can come from stale context carryover, inherently context-heavy work, or abandoned runs that loaded too much context; starting fresh with only the current goal and relevant files can cut repeated prompt overhead.`,
    impact,
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'session-opener',
      label: 'Paste at the start of your NEXT expensive thread (one-time, do not add to CLAUDE.md):',
      text: CONTEXT_HEAVY_OPENER,
    },
  }
}

export function detectSessionOutliers(projects: ProjectSummary[], excludedSessionIds?: ReadonlySet<string>): WasteFinding | null {
  type Outlier = {
    project: string
    sessionId: string
    date: string
    cost: number
    avgCost: number
    ratio: number
    tokenExcess: number
  }

  const outliers: Outlier[] = []

  for (const project of projects) {
    const sessions = project.sessions.filter(s => s.totalCostUSD > 0)
    if (sessions.length < MIN_SESSIONS_FOR_OUTLIER) continue

    const totalCost = sessions.reduce((sum, s) => sum + s.totalCostUSD, 0)
    const totalTokens = sessions.reduce((sum, s) => sum + sessionTokenTotal(s), 0)
    for (const session of sessions) {
      const avgCost = (totalCost - session.totalCostUSD) / (sessions.length - 1)
      const avgTokens = (totalTokens - sessionTokenTotal(session)) / (sessions.length - 1)
      if (avgCost <= 0) continue

      const ratio = session.totalCostUSD / avgCost
      if (ratio <= SESSION_OUTLIER_MULTIPLIER) continue
      if (session.totalCostUSD < MIN_SESSION_OUTLIER_COST_USD) continue
      if (excludedSessionIds?.has(session.sessionId)) continue

      outliers.push({
        project: project.project,
        sessionId: session.sessionId,
        date: session.firstTimestamp.slice(0, 10),
        cost: session.totalCostUSD,
        avgCost,
        ratio,
        tokenExcess: Math.max(0, sessionTokenTotal(session) - avgTokens),
      })
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
    title: `${outliers.length} high-cost session outlier${outliers.length === 1 ? '' : 's'}`,
    explanation: `Sessions costing more than ${SESSION_OUTLIER_MULTIPLIER}x their peer-session average in the same project: ${list}${extra}. These usually come from broad prompts, runaway loops, or context-heavy work that should be split into smaller sessions.`,
    impact: outliers.length >= 3 || totalExcessCost >= 10 ? 'high' : 'medium',
    tokensSaved,
    fix: {
      type: 'paste',
      destination: 'session-opener',
      label: 'Paste at the start of your NEXT expensive thread (one-time, do not add to CLAUDE.md):',
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
        firstSession === null
        || new Date(session.firstTimestamp).getTime() < new Date(firstSession.firstTimestamp).getTime()
      ) {
        firstSession = session
      }
    }

    if (firstSession) firstSessionIds.add(firstSession.sessionId)
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
    score >= GRADE_A_MIN ? 'A' :
    score >= GRADE_B_MIN ? 'B' :
    score >= GRADE_C_MIN ? 'C' :
    score >= GRADE_D_MIN ? 'D' : 'F'
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

export function computeTrend(inputs: TrendInputs): Trend | 'resolved' {
  const { recentCount, recentWindowMs, baselineCount, baselineWindowMs, hasRecentActivity } = inputs
  if (baselineCount === 0) return 'active'
  if (recentCount === 0 && hasRecentActivity) return 'resolved'
  if (!hasRecentActivity) return 'active'
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
): Trend | 'resolved' {
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
// Cost estimation
// ============================================================================

const INPUT_COST_RATIO = 0.7
const DEFAULT_COST_PER_TOKEN = 0

export function computeInputCostRate(projects: ProjectSummary[]): number {
  const sessions = projects.flatMap(p => p.sessions)
  const totalCost = sessions.reduce((s, sess) => s + sess.totalCostUSD, 0)
  const totalTokens = sessions.reduce((s, sess) =>
    s + sess.totalInputTokens + sess.totalCacheReadTokens + sess.totalCacheWriteTokens, 0)
  if (totalTokens === 0 || totalCost === 0) return DEFAULT_COST_PER_TOKEN
  return (totalCost * INPUT_COST_RATIO) / totalTokens
}

// ============================================================================
// Scope + main entry point
// ============================================================================

type DateRange = { start: Date; end: Date }

/** Shared by the Optimize and yield computations (ticket 29): the Optimize
 * scope's DateRange, applied at the SQL read by the aggregation seam so both
 * the Waste findings and the Reverts/Abandoned yield share the same window. */
export function scopeDateRange(scope: OverviewScope, now: Date): DateRange | null {
  if (scope.range) {
    const start = new Date(`${scope.range.since}T00:00:00`)
    const end = new Date(`${scope.range.until}T23:59:59.999`)
    return { start, end }
  }
  const start = new Date(`${periodWindowStart(scope.period, now)}T00:00:00`)
  return { start, end: now }
}

/** Run the 16 ported detectors over the scoped projects and produce the
 * section's read-only payload. Order-sensitive exclusions:
 * low-worth → context-bloat → outliers, each later detector excluding sessions
 * already named by an earlier one. The ledger-backed path scopes at the SQL
 * read and groups through `groupSummariesIntoProjects`. */
export async function buildOptimizePayload(
  projects: ProjectSummary[],
  scope: OverviewScope,
  opts: { now?: Date; homeDir?: string } = {},
): Promise<OptimizePayload> {
  const now = opts.now ?? new Date()
  const home = opts.homeDir ?? homedir()
  const dateRange = scopeDateRange(scope, now)
  const recentCutoffMs = now.getTime() - RECENT_WINDOW_MS

  const sessions = projects.flatMap(p => p.sessions)
  const periodCostUSD = projects.reduce((s, p) => s + p.totalCostUSD, 0)
  const calls = projects.reduce((s, p) => s + p.totalApiCalls, 0)

  const empty: OptimizePayload = {
    period: { start: dateRange?.start.toISOString() ?? null, end: dateRange?.end.toISOString() ?? null },
    summary: {
      healthScore: 100,
      healthGrade: 'A',
      findingCount: 0,
      periodCostUSD,
      sessions: sessions.length,
      calls,
      potentialSavingsTokens: 0,
      potentialSavingsCostUSD: 0,
      potentialSavingsPercent: null,
      costRateUSD: 0,
    },
    findings: [],
  }
  if (projects.length === 0) return empty

  const costRate = computeInputCostRate(projects)
  const scan = collectScanData(projects, recentCutoffMs)
  const projectCwds = new Set(projects.map(p => p.projectPath || p.project))
  const mcpCoverage = aggregateMcpCoverage(projects)

  const findings: WasteFinding[] = []
  const lowWorthSessionIds = new Set(findLowWorthCandidates(projects).map(c => c.sessionId))
  const contextBloatVisibleIds = new Set(
    findContextBloatCandidates(projects)
      .filter(c => !lowWorthSessionIds.has(c.sessionId))
      .map(c => c.sessionId),
  )
  const firstSessionIds = findYoungProjectFirstSessionIds(projects)
  const outlierExclusions = new Set([...lowWorthSessionIds, ...contextBloatVisibleIds, ...firstSessionIds])

  const syncDetectors: Array<() => WasteFinding | null> = [
    () => detectCacheBloat(scan.cacheEvents, projects, dateRange ?? undefined, now),
    () => detectLowReadEditRatio(scan.steps),
    () => detectJunkReads(scan.steps, dateRange ?? undefined, now),
    () => detectDuplicateReads(scan.steps, dateRange ?? undefined, now),
    () => detectMcpToolCoverage(projects, mcpCoverage),
    () => detectMcpProfileAdvisor(projects, mcpCoverage),
    () => detectMcpDeferralOff(scan.steps, projects, projectCwds, home),
    () => detectMcpAlwaysLoadHygiene(projects, projectCwds, mcpCoverage, home),
    () => detectMcpDeferThreshold(projects, projectCwds, home),
    () => detectCapabilityReliability(projects),
    () => detectLowWorthSessions(projects),
    () => detectContextBloat(projects, lowWorthSessionIds),
    () => detectSessionOutliers(projects, outlierExclusions),
  ]
  for (const detect of syncDetectors) {
    const finding = detect()
    if (finding) findings.push(finding)
  }

  const ghostResults = await Promise.all([
    detectGhostAgents(scan.subagentTypes, home),
    detectGhostSkills(scan.skills, home),
    detectGhostCommands(scan.userMessages, home),
  ])
  for (const f of ghostResults) if (f) findings.push(f)

  findings.sort((a, b) => urgencyScore(b) - urgencyScore(a))
  const { score, grade } = computeHealth(findings)

  const potentialSavingsTokens = findings.reduce((s, f) => s + f.tokensSaved, 0)
  const potentialSavingsCostUSD = potentialSavingsTokens * costRate
  const potentialSavingsPercent = periodCostUSD > 0
    ? Math.round((potentialSavingsCostUSD / periodCostUSD) * 1000) / 10
    : null

  return {
    period: { start: dateRange?.start.toISOString() ?? null, end: dateRange?.end.toISOString() ?? null },
    summary: {
      healthScore: score,
      healthGrade: grade,
      findingCount: findings.length,
      periodCostUSD,
      sessions: sessions.length,
      calls,
      potentialSavingsTokens,
      potentialSavingsCostUSD,
      potentialSavingsPercent,
      costRateUSD: costRate,
    },
    findings: findings.map(f => ({
      id: f.id,
      title: f.title,
      explanation: f.explanation,
      severity: f.impact,
      trend: f.trend ?? null,
      tokensSaved: f.tokensSaved,
      estimatedSavingsUSD: f.tokensSaved * costRate,
      fix: f.fix,
    })),
  }
}

/**
 * Ledger-backed Optimize payload (map 06): the aggregation seam applies the
 * scope's range/provider at the SQL read (the detector walk then uses the
 * ledger's per-call `toolSequence`, `mcpTools`, `skills`, `subagentTypes` and
 * per-session `mcpInventory`) and groups through `groupSummariesIntoProjects`
 * before the same `buildOptimizePayload` core.
 */
export async function buildOptimizeViewFromLedger(
  store: LedgerStore,
  scope: OverviewScope,
  opts: { now?: Date; homeDir?: string } = {},
): Promise<OptimizePayload> {
  const now = opts.now ?? new Date()
  const summaries = buildSessionSummaries(store, {
    range: overviewDateRange(scope, now),
    provider: scope.provider,
  })
  return optimizePayloadSchema.parse(await buildOptimizePayload(groupSummariesIntoProjects(summaries), scope, opts))
}

// The grouping seam's home is the aggregation layer; re-exported here so the
// Yield section (which shares optimize-view's scoping vocabulary) imports from
// one place.
export { groupSummariesIntoProjects } from './store/aggregate.js'