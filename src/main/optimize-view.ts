import * as Schema from 'effect/Schema'

import { type OptimizePayload, optimizePayloadSchema } from '../shared/schemas/optimize.js'
import {
  defaultHomeDirectory,
  findDeferralEnvSetting,
  loadMcpConfigs,
  loadOptimizeSetup,
} from './assistant-setup-live.js'
import * as calculation from './optimize-calculation.js'
import { calculateOptimizePayload, type DateRange } from './optimize-calculation.js'
import type { OverviewScope } from './overview.js'
import { overviewDateRange, scopeDateRange } from './overview-scope.js'
import type { DeferralEnvHit, OptimizeSetup } from './setup-facts.js'
import { buildSessionSummaries, groupSummariesIntoProjects } from './store/aggregate.js'
import type { LedgerStore } from './store/ledger.js'

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
export type { DateRange }
export { groupSummariesIntoProjects, scopeDateRange }
export {
  aggregateMcpCoverage,
  computeHealth,
  computeInputCostRate,
  computeTrend,
  detectCacheBloat,
  detectCapabilityReliability,
  detectContextBloat,
  detectDuplicateReads,
  detectJunkReads,
  detectLowReadEditRatio,
  detectLowWorthSessions,
  detectMcpProfileAdvisor,
  detectMcpToolCoverage,
  detectSessionOutliers,
  findContextBloatCandidates,
  findLowWorthCandidates,
  formatTokens,
} from './optimize-calculation.js'

function makeSetup(projectDirectories: Iterable<string>, home = defaultHomeDirectory()): OptimizeSetup {
  const dirs = [...projectDirectories]
  const envSettings = new Map<string, DeferralEnvHit | null>()
  for (const name of ['ENABLE_TOOL_SEARCH', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_VERTEX']) {
    envSettings.set(name, findDeferralEnvSetting(name, dirs, home))
  }
  return { home, mcpConfigs: loadMcpConfigs(dirs, home), envSettings, agents: [], skills: [], commands: [] }
}

/** Legacy synchronous file-discovery APIs. New application queries use AssistantSetup. */
export { findDeferralEnvSetting, loadMcpConfigs }

export function detectMcpDeferralOff(
  steps: Parameters<typeof calculation.detectMcpDeferralOff>[0],
  projects: Parameters<typeof calculation.detectMcpDeferralOff>[1],
  projectCwds: Set<string>,
  home = defaultHomeDirectory(),
) {
  return calculation.detectMcpDeferralOff(steps, projects, makeSetup(projectCwds, home))
}

export function detectMcpAlwaysLoadHygiene(
  projects: Parameters<typeof calculation.detectMcpAlwaysLoadHygiene>[0],
  projectCwds: Set<string>,
  mcpCoverage = calculation.aggregateMcpCoverage(projects),
  home = defaultHomeDirectory(),
) {
  return calculation.detectMcpAlwaysLoadHygiene(projects, makeSetup(projectCwds, home), mcpCoverage)
}

export function detectMcpDeferThreshold(
  projects: Parameters<typeof calculation.detectMcpDeferThreshold>[0],
  projectCwds: Set<string>,
  home = defaultHomeDirectory(),
) {
  return calculation.detectMcpDeferThreshold(projects, makeSetup(projectCwds, home))
}

export async function detectGhostAgents(names: Iterable<string>, home = defaultHomeDirectory()) {
  const setup = await loadOptimizeSetup([], home)
  return calculation.detectGhostAgents(names, setup.agents)
}

export async function detectGhostSkills(names: Iterable<string>, home = defaultHomeDirectory()) {
  const setup = await loadOptimizeSetup([], home)
  return calculation.detectGhostSkills(names, setup.skills)
}

export async function detectGhostCommands(messages: string[], home = defaultHomeDirectory()) {
  const setup = await loadOptimizeSetup([], home)
  return calculation.detectGhostCommands(messages, setup.commands)
}

export async function buildOptimizePayload(
  projects: Parameters<typeof calculateOptimizePayload>[0],
  scope: OverviewScope,
  opts: { now?: Date; homeDir?: string } = {},
): Promise<OptimizePayload> {
  const now = opts.now ?? new Date()
  const setup =
    projects.length === 0
      ? {
          home: opts.homeDir ?? '',
          mcpConfigs: new Map(),
          envSettings: new Map(),
          agents: [],
          skills: [],
          commands: [],
        }
      : await loadOptimizeSetup(
          [...new Set(projects.map(project => project.projectPath || project.project))],
          opts.homeDir,
        )
  return calculateOptimizePayload(projects, scope, setup, now)
}

export async function buildOptimizeViewFromLedger(
  store: LedgerStore,
  scope: OverviewScope,
  opts: { now?: Date; homeDir?: string } = {},
): Promise<OptimizePayload> {
  const now = opts.now ?? new Date()
  const summaries = buildSessionSummaries(store, { range: overviewDateRange(scope, now), provider: scope.provider })
  const projects = groupSummariesIntoProjects(summaries)
  const input: OptimizeSetup =
    projects.length === 0
      ? {
          home: opts.homeDir ?? '',
          mcpConfigs: new Map(),
          envSettings: new Map(),
          agents: [],
          skills: [],
          commands: [],
        }
      : await loadOptimizeSetup(
          [...new Set(projects.map(project => project.projectPath || project.project))],
          opts.homeDir,
        )
  return Schema.decodeUnknownSync(optimizePayloadSchema)(calculateOptimizePayload(projects, scope, input, now))
}
