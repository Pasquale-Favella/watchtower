import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import { AssistantSetup } from '../src/main/application/assistant-setup.js'
import { queryOptimizeView } from '../src/main/application/optimize-query.js'
import {
  aggregateMcpCoverage,
  calculateOptimizePayload,
  computeHealth,
  computeTrend,
  detectCacheBloat,
  detectCapabilityReliability,
  detectContextBloat,
  detectDuplicateReads,
  detectGhostAgents,
  detectGhostCommands,
  detectGhostSkills,
  detectJunkReads,
  detectLowCacheReuse,
  detectLowReadEditRatio,
  detectLowWorthSessions,
  detectMcpAlwaysLoadHygiene,
  detectMcpDeferralOff,
  detectMcpDeferThreshold,
  detectMcpProfileAdvisor,
  detectMcpToolCoverage,
  detectSessionOutliers,
  findContextBloatCandidates,
  type FindingId,
  findLowWorthCandidates,
  formatTokens,
} from '../src/main/optimize-calculation.js'
import type { CachedCall, CachedFile } from '../src/main/pipeline/session-cache.js'
import type {
  ClassifiedTurn,
  ParsedApiCall,
  ProjectSummary,
  SessionSummary,
  ToolCall,
} from '../src/main/pipeline/types.js'
import type { OptimizeSetup } from '../src/main/setup-facts.js'
import { LedgerIngest } from '../src/main/store/ledger-ports.js'
import type { OptimizePayload } from '../src/shared/schemas/optimize.js'
import type { OverviewScope } from '../src/shared/schemas/overview.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'
import { atTime, openLedgerFixture, viewInputs } from './fixtures/ledger-runtime.js'
import { buildFixtureReport } from './fixtures/report.js'

const BASE_SESSION = buildFixtureReport()[0]!.sessions[0]!
const BASE_TURN = BASE_SESSION.turns[0]!
const BASE_CALL = BASE_TURN.assistantCalls[0]!

function ALL_ZERO_CATEGORIES(): SessionSummary['categoryBreakdown'] {
  const empty = { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 }
  return Object.fromEntries(
    Object.keys(BASE_SESSION.categoryBreakdown).map(k => [k, { ...empty }]),
  ) as SessionSummary['categoryBreakdown']
}

function makeCall(
  index: number,
  opts: {
    cost?: number
    input?: number
    output?: number
    cacheCreation?: number
    cacheRead?: number
    tools?: string[]
    mcpTools?: string[]
    skills?: string[]
    subagentTypes?: string[]
    toolSequence?: ToolCall[][]
    date?: string
    provider?: string
  } = {},
): ParsedApiCall {
  const iso = new Date(`${opts.date ?? '2026-07-10'}T12:00:00`).toISOString()
  return {
    ...BASE_CALL,
    provider: opts.provider ?? 'claude',
    costUSD: opts.cost ?? 0,
    usage: {
      ...BASE_CALL.usage,
      inputTokens: opts.input ?? 100,
      outputTokens: opts.output ?? 50,
      cacheCreationInputTokens: opts.cacheCreation ?? 0,
      cacheReadInputTokens: opts.cacheRead ?? BASE_CALL.usage.cacheReadInputTokens,
    },
    tools: opts.tools ?? ['edit'],
    mcpTools: opts.mcpTools ?? [],
    skills: opts.skills ?? [],
    subagentTypes: opts.subagentTypes ?? [],
    toolSequence: opts.toolSequence,
    timestamp: iso,
    deduplicationKey: `dedup-${index}`,
  }
}

function makeTurn(
  index: number,
  opts: {
    calls: ParsedApiCall[]
    hasEdits?: boolean
    retries?: number
    date?: string
  },
): ClassifiedTurn {
  const iso = new Date(`${opts.date ?? '2026-07-10'}T12:00:00`).toISOString()
  return {
    ...BASE_TURN,
    userMessage: `prompt ${index}`,
    sessionId: `sess-${index}`,
    assistantCalls: opts.calls,
    hasEdits: opts.hasEdits ?? true,
    retries: opts.retries ?? 0,
    timestamp: iso,
  }
}

function makeSession(
  index: number,
  opts: {
    turns: ClassifiedTurn[]
    cost?: number
    input?: number
    output?: number
    cacheWrite?: number
    cacheRead?: number
    date?: string
    project?: string
    categories?: SessionSummary['categoryBreakdown']
    bashBreakdown?: SessionSummary['bashBreakdown']
    mcpInventory?: string[]
    mcpBreakdown?: SessionSummary['mcpBreakdown']
    apiCalls?: number
  },
): SessionSummary {
  const first = opts.date ?? '2026-07-10'
  const iso = new Date(`${first}T09:00:00`).toISOString()
  const calls = opts.turns.flatMap(t => t.assistantCalls)
  return {
    ...BASE_SESSION,
    sessionId: `sess-${index}`,
    project: opts.project ?? BASE_SESSION.project,
    firstTimestamp: iso,
    lastTimestamp: iso,
    totalCostUSD: opts.cost ?? calls.reduce((s, c) => s + c.costUSD, 0),
    totalInputTokens: opts.input ?? calls.reduce((s, c) => s + c.usage.inputTokens, 0),
    totalOutputTokens: opts.output ?? calls.reduce((s, c) => s + c.usage.outputTokens, 0),
    totalCacheReadTokens: opts.cacheRead ?? calls.reduce((s, c) => s + c.usage.cacheReadInputTokens, 0),
    totalCacheWriteTokens: opts.cacheWrite ?? calls.reduce((s, c) => s + c.usage.cacheCreationInputTokens, 0),
    apiCalls: opts.apiCalls ?? calls.length,
    turns: opts.turns,
    categoryBreakdown: opts.categories ?? { ...BASE_SESSION.categoryBreakdown },
    bashBreakdown: opts.bashBreakdown ?? { ...BASE_SESSION.bashBreakdown },
    mcpInventory: opts.mcpInventory,
    mcpBreakdown: opts.mcpBreakdown ?? {},
  }
}

function groupByProject(sessions: SessionSummary[]): ProjectSummary[] {
  const byProject = new Map<string, SessionSummary[]>()
  for (const session of sessions) {
    const list = byProject.get(session.project)
    if (list) list.push(session)
    else byProject.set(session.project, [session])
  }
  return [...byProject.entries()].map(([project, list]) => ({
    project,
    projectPath: `/tmp/${project}`,
    totalCostUSD: list.reduce((s, sess) => s + sess.totalCostUSD, 0),
    totalSavingsUSD: 0,
    totalEstimatedCostUSD: 0,
    totalApiCalls: list.reduce((s, sess) => s + sess.apiCalls, 0),
    totalProxiedCostUSD: 0,
    sessions: list,
  }))
}

const NOW = new Date(2026, 6, 15)

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), 'opt-'))
}

function optimizeSetup(
  options: { configured?: string[]; alwaysLoad?: string[]; deferSetting?: string } = {},
): OptimizeSetup {
  const home = '/home/test'
  const configured = options.configured ?? []
  return {
    home,
    mcpConfigs: new Map(
      configured.map(name => [
        name,
        {
          normalized: name,
          original: name,
          mtime: 0,
          alwaysLoadPaths: (options.alwaysLoad ?? []).includes(name) ? [`${home}/.claude/settings.json`] : [],
        },
      ]),
    ),
    envSettings: new Map(
      options.deferSetting
        ? [
            [
              'ENABLE_TOOL_SEARCH',
              { value: options.deferSetting, scope: 'user', path: `${home}/.claude/settings.local.json` },
            ],
          ]
        : [],
    ),
    agents: [],
    skills: [],
    commands: [],
  }
}

function readSteps(
  projects: ProjectSummary[],
): Array<{ name: string; filePath?: string; sessionId: string; project: string; recent: boolean }> {
  const steps: Array<{ name: string; filePath?: string; sessionId: string; project: string; recent: boolean }> = []
  for (const project of projects) {
    for (const session of project.sessions) {
      for (const turn of session.turns) {
        for (const call of turn.assistantCalls) {
          for (const stepArr of call.toolSequence ?? []) {
            for (const step of stepArr) {
              steps.push({
                name: step.tool,
                filePath: step.file,
                sessionId: session.sessionId,
                project: project.project,
                recent: false,
              })
            }
          }
        }
      }
    }
  }
  return steps
}

// ── Application Optimize query ────────────────────────────────────────────

type OptimizeRuntime = ReturnType<typeof openLedgerFixture>['runtime']

const emptyAssistantSetup = AssistantSetup.of({
  getSkillInventory: () => Effect.succeed([]),
  getOptimizeSetup: (_directories, homeDir) =>
    Effect.succeed({
      home: homeDir ?? '',
      mcpConfigs: new Map(),
      envSettings: new Map(),
      agents: [],
      skills: [],
      commands: [],
    }),
})

function optimizeView(runtime: OptimizeRuntime, scope: OverviewScope, homeDir: string): Promise<OptimizePayload> {
  return runtime.runPromise(
    atTime(
      Effect.provideService(queryOptimizeView({ ...viewInputs(scope), homeDir }), AssistantSetup, emptyAssistantSetup),
      NOW,
    ),
  )
}

function optCachedFile(
  index: number,
  opts: {
    sessionId: string
    date?: string
    cost?: number
    toolSequence?: ToolCall[][]
  },
): CachedFile {
  const iso = new Date(`${opts.date ?? '2026-07-13'}T12:00:00`).toISOString()
  const call: CachedCall = {
    ...buildFixtureCachedCall(index),
    costUSD: opts.cost ?? 0,
    ...(opts.toolSequence ? { toolSequence: opts.toolSequence } : {}),
    timestamp: iso,
  }
  const turn = buildFixtureCachedTurn(index, `prompt ${index}`, {
    sessionId: opts.sessionId,
    timestamp: iso,
    calls: [call],
  })
  return buildFixtureCachedFile({ canonicalProjectName: 'demo-project', title: '', turns: [turn] })
}

function optPort(runtime: OptimizeRuntime, files: CachedFile[]): void {
  files.forEach((file, i) => {
    runtime.runSync(
      Effect.flatMap(LedgerIngest, ingest =>
        ingest.portIn({
          provider: 'claude',
          envFingerprint: 'env-demo',
          filePath: `/cache/claude/${file.turns[0]?.sessionId ?? `sess-${i}`}.jsonl`,
          verdict: 'new',
          cachedFile: file,
        }),
      ),
    )
  })
}

describe('queryOptimizeView', () => {
  it('returns unknown setup health and savings for an empty ledger', async () => {
    const { runtime } = openLedgerFixture()
    const payload = await optimizeView(runtime, { period: 'lifetime' }, tempHome())
    expect(payload.findings).toEqual([])
    expect(payload.summary).toMatchObject({
      healthScore: null,
      healthGrade: null,
      findingCount: 0,
      sessions: 0,
      calls: 0,
    })
    expect(payload.period.start).not.toBeNull()
  })

  it('runs the read detectors over the ledger toolSequence and reports junk reads', async () => {
    const file = optCachedFile(0, {
      sessionId: 'sess-o0',
      cost: 5,
      toolSequence: [
        [{ tool: 'Read', file: '/tmp/demo/build/a/index.js' }],
        [{ tool: 'Read', file: '/tmp/demo/dist/b.js' }],
        [{ tool: 'Read', file: '/tmp/demo/coverage/c/lib.js' }],
      ],
    })
    const { runtime } = openLedgerFixture()
    optPort(runtime, [file])
    const payload = await optimizeView(runtime, { period: 'lifetime' }, tempHome())

    const junk = payload.findings.find(f => f.id === 'build-folder-reads')
    expect(junk).toBeDefined()
    expect(junk!.severity).toBe('low')
    expect(junk!.tokensSaved).toBeNull()
    expect(junk!.quantity).toEqual({ value: 3, unit: 'reads' })
    expect(junk!.estimatedSavingsUSD).toBeNull()
    expect(junk!.associatedSpendUSD).toBe(5)
    expect(payload.summary.findingCount).toBeGreaterThanOrEqual(1)
    expect(payload.summary.potentialSavingsTokens).toBeNull()
    expect(payload.summary.periodCostUSD).toBe(5)
  })

  it('honors the custom-range scope at the query', async () => {
    const inRange = optCachedFile(0, { sessionId: 'sess-o1', date: '2026-07-13', cost: 1 })
    const outRange = optCachedFile(1, { sessionId: 'sess-o2', date: '2026-07-14', cost: 2 })
    const { runtime } = openLedgerFixture()
    optPort(runtime, [inRange, outRange])
    const payload = await optimizeView(
      runtime,
      { period: 'lifetime', range: { since: '2026-07-12', until: '2026-07-13' } },
      tempHome(),
    )
    expect(payload.summary.sessions).toBe(1)
    expect(payload.summary.calls).toBe(1)
  })
})

describe('formatTokens', () => {
  it('formats counts with K/M suffixes', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(500)).toBe('500')
    expect(formatTokens(1500)).toBe('1.5K')
    expect(formatTokens(2_500_000)).toBe('2.5M')
    expect(formatTokens(NaN)).toBe('?')
    expect(formatTokens(-1)).toBe('0')
  })
})

describe('computeHealth', () => {
  it('grades A at 100 with no findings', () => {
    expect(computeHealth([])).toEqual({ score: 100, grade: 'A' })
  })

  it('weights high/medium/low impacts against the 80-point penalty cap', () => {
    const finding = (impact: 'high' | 'medium' | 'low', tokensSaved = 0) => ({
      id: 'build-folder-reads' as FindingId,
      title: 't',
      explanation: 'e',
      impact,
      tokensSaved,
      fix: { type: 'paste' as const, label: 'l', text: 'x' },
    })
    expect(computeHealth([finding('high')])).toEqual({ score: 85, grade: 'B' })
    expect(computeHealth([finding('medium')])).toEqual({ score: 93, grade: 'A' })
    expect(computeHealth([finding('low')])).toEqual({ score: 97, grade: 'A' })
    // Six high-impact findings saturate at the 80-point penalty floor.
    const many = Array.from({ length: 6 }, () => finding('high'))
    expect(computeHealth(many)).toEqual({ score: 20, grade: 'F' })
  })
})

describe('computeTrend', () => {
  it('distinguishes insufficient evidence from active, improving and resolved trends', () => {
    expect(
      computeTrend({
        recentCount: 0,
        recentWindowMs: 1000,
        baselineCount: 0,
        baselineWindowMs: 1000,
        hasRecentActivity: true,
      }),
    ).toBeNull()
    expect(
      computeTrend({
        recentCount: 0,
        recentWindowMs: 1000,
        baselineCount: 5,
        baselineWindowMs: 1000,
        hasRecentActivity: true,
      }),
    ).toBe('resolved')
    // Without recent activity there is no comparison to make.
    expect(
      computeTrend({
        recentCount: 0,
        recentWindowMs: 1000,
        baselineCount: 5,
        baselineWindowMs: 1000,
        hasRecentActivity: false,
      }),
    ).toBeNull()
    // Recent rate well below half the baseline rate reads as improving.
    expect(
      computeTrend({
        recentCount: 1,
        recentWindowMs: 10_000,
        baselineCount: 100,
        baselineWindowMs: 1_000,
        hasRecentActivity: true,
      }),
    ).toBe('improving')
  })
})

describe('Optimize accounting', () => {
  it('keeps overlapping diagnostics separate from potential financial savings', () => {
    const session = makeSession(0, {
      turns: [makeTurn(0, { calls: [makeCall(0, { cost: 12, input: 100_000, output: 1 })], hasEdits: false })],
      categories: ALL_ZERO_CATEGORIES(),
    })
    const payload = calculateOptimizePayload(groupByProject([session]), { period: 'lifetime' }, optimizeSetup(), NOW)
    expect(payload.summary.potentialSavingsCostUSD).toBeNull()
    expect(payload.summary.potentialSavingsPercent).toBeNull()
    expect(payload.summary.potentialSavingsTokens).toBeNull()
    expect(payload.findings.length).toBeGreaterThan(0)
    expect(payload.findings.every(f => f.estimatedSavingsUSD === null && f.tokensSaved === null)).toBe(true)
    expect(payload.findings.find(f => f.id === 'low-worth-sessions')?.associatedSpendUSD).toBe(12)
    expect(payload.summary).not.toHaveProperty('costRateUSD')
  })
})

describe('detectJunkReads', () => {
  it('flags reads into generated folders once past the threshold', () => {
    const steps = [
      { name: 'Read', filePath: '/tmp/demo/build/a/index.js', sessionId: 's', project: 'p', recent: false },
      { name: 'Read', filePath: '/tmp/demo/dist/b.js', sessionId: 's', project: 'p', recent: false },
      { name: 'Read', filePath: '/tmp/demo/coverage/c/lib.js', sessionId: 's', project: 'p', recent: false },
    ]
    const finding = detectJunkReads(steps, undefined, NOW)
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('build-folder-reads')
    expect(finding!.tokensSaved).toBe(3 * 600)
    expect(finding!.fix.type).toBe('paste')
  })

  it('stays quiet under the minimum count', () => {
    const steps = [
      { name: 'Read', filePath: '/tmp/demo/build/a/index.js', sessionId: 's', project: 'p', recent: false },
      { name: 'Read', filePath: '/tmp/demo/dist/b.js', sessionId: 's', project: 'p', recent: false },
    ]
    expect(detectJunkReads(steps, undefined, NOW)).toBeNull()
  })

  it('normalizes Windows backslash paths', () => {
    const steps = [
      { name: 'Read', filePath: 'C:/demo/build/a/index.js', sessionId: 's', project: 'p', recent: false },
      { name: 'Read', filePath: 'C:/demo/dist/b.js', sessionId: 's', project: 'p', recent: false },
      { name: 'Read', filePath: 'C:/demo/coverage/c/lib.js', sessionId: 's', project: 'p', recent: false },
    ]
    const finding = detectJunkReads(steps, undefined, NOW)
    expect(finding?.explanation).toContain('build/')
  })
})

describe('detectDuplicateReads', () => {
  it('flags redundant re-reads of the same file in a session', () => {
    const steps = Array.from({ length: 6 }, () => ({
      name: 'Read' as const,
      filePath: '/tmp/demo/src/index.ts',
      sessionId: 's',
      project: 'p',
      recent: false,
    }))
    const finding = detectDuplicateReads(steps, undefined, NOW)
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('redundant-rereads')
    // 6 reads → 5 duplicates.
    expect(finding!.tokensSaved).toBe(5 * 600)
  })

  it('ignores junk-dir files when counting duplicates', () => {
    const steps = Array.from({ length: 6 }, () => ({
      name: 'Read' as const,
      filePath: '/tmp/demo/dist/pkg/index.js',
      sessionId: 's',
      project: 'p',
      recent: false,
    }))
    expect(detectDuplicateReads(steps, undefined, NOW)).toBeNull()
  })
})

describe('detectLowReadEditRatio', () => {
  it('flags edit-heavy sessions with a low read:edit ratio', () => {
    const steps: Array<{ name: string; filePath?: string; sessionId: string; project: string; recent: boolean }> = []
    for (let i = 0; i < 10; i++)
      steps.push({ name: 'Edit', filePath: '/tmp/demo/src/a.ts', sessionId: 's', project: 'p', recent: false })
    for (let i = 0; i < 10; i++)
      steps.push({ name: 'Read', filePath: '/tmp/demo/src/b.ts', sessionId: 's', project: 'p', recent: false })
    const finding = detectLowReadEditRatio(steps)
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('read-edit-ratio')
    // ratio 1.0:1, under the 2.0 high threshold.
    expect(finding!.impact).toBe('high')
  })

  it('stays quiet with too few edits to judge', () => {
    const steps: Array<{ name: string; filePath?: string; sessionId: string; project: string; recent: boolean }> = []
    for (let i = 0; i < 3; i++)
      steps.push({ name: 'Edit', filePath: '/tmp/demo/src/a.ts', sessionId: 's', project: 'p', recent: false })
    expect(detectLowReadEditRatio(steps)).toBeNull()
  })
})

describe('detectCacheBloat', () => {
  it('compares positive-write calls with a positive-write call baseline', () => {
    const apiCalls = Array.from({ length: 10 }, (_, i) => ({
      cacheCreationTokens: i < 4 ? 20_000 : 100_000,
      version: '',
      recent: false,
    }))
    const projects = groupByProject([
      makeSession(0, {
        turns: [makeTurn(0, { calls: [makeCall(0, { cacheCreation: 100_000 })] })],
        cacheWrite: 100_000,
      }),
    ])
    const finding = detectCacheBloat(apiCalls, projects, undefined, NOW)
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('warmup-heavy')
    // The lower-quartile call is 20k. Session sums do not supply this baseline.
    expect(finding!.tokensSaved).toBe((100_000 - 20_000) * 10)
    expect(finding!.fix).toMatchObject({ destination: 'prompt' })
  })

  it('stays quiet with few cache-creation samples', () => {
    const apiCalls = Array.from({ length: 5 }, () => ({ cacheCreationTokens: 100_000, version: '', recent: false }))
    expect(detectCacheBloat(apiCalls, [], undefined, NOW)).toBeNull()
  })
})

describe('aggregateMcpCoverage / detectMcpToolCoverage', () => {
  const serverTools = Array.from({ length: 15 }, (_, i) => `mcp__filesystem__tool${i}`)

  it('aggregates per-server inventory, invocations, and coverage ratio', () => {
    const session = makeSession(0, {
      turns: [makeTurn(0, { calls: [makeCall(0, { mcpTools: ['mcp__filesystem__tool0'] })] })],
      mcpInventory: serverTools,
      mcpBreakdown: { filesystem: { calls: 1 } },
    })
    const coverage = aggregateMcpCoverage(groupByProject([session]))
    expect(coverage).toHaveLength(1)
    const server = coverage[0]!
    expect(server.server).toBe('filesystem')
    expect(server.toolsAvailable).toBe(15)
    expect(server.toolsInvoked).toBe(1)
    expect(server.unusedTools).toHaveLength(14)
    expect(server.invocations).toBe(1)
    expect(server.loadedSessions).toBe(1)
  })

  it('flags servers with low coverage across enough sessions', () => {
    const sessions = [
      makeSession(0, {
        turns: [makeTurn(0, { calls: [makeCall(0, { mcpTools: ['mcp__filesystem__tool0'] })] })],
        mcpInventory: serverTools,
        mcpBreakdown: { filesystem: { calls: 1 } },
      }),
      makeSession(1, {
        turns: [makeTurn(1, { calls: [makeCall(1, { mcpTools: ['mcp__filesystem__tool0'] })] })],
        mcpInventory: serverTools,
        mcpBreakdown: { filesystem: { calls: 1 } },
      }),
    ]
    const projects = groupByProject(sessions)
    const finding = detectMcpToolCoverage(projects)
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('mcp-low-coverage')
    expect(finding!.tokensSaved).toBeGreaterThan(0)
  })
})

describe('detectMcpProfileAdvisor', () => {
  const serverTools = ['mcp__db__tool0', 'mcp__db__tool1', 'mcp__db__tool2', 'mcp__db__tool3', 'mcp__db__tool4']

  it('flags a server loaded but unused in cold projects', () => {
    const sessions = [
      makeSession(0, {
        project: 'proj-hot',
        turns: [makeTurn(0, { calls: [makeCall(0, { mcpTools: ['mcp__db__tool0'] })] })],
        mcpInventory: serverTools,
        mcpBreakdown: { db: { calls: 2 } },
      }),
      makeSession(1, {
        project: 'proj-cold-a',
        turns: [makeTurn(1, { calls: [makeCall(1, { cacheCreation: 10000 })] })],
        mcpInventory: serverTools,
      }),
      makeSession(2, {
        project: 'proj-cold-b',
        turns: [makeTurn(2, { calls: [makeCall(2, { cacheCreation: 10000 })] })],
        mcpInventory: serverTools,
      }),
    ]
    const projects = groupByProject(sessions)
    const finding = detectMcpProfileAdvisor(projects)
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('mcp-project-scope')
    expect(finding!.impact).toBe('medium')
    expect(finding!.tokensSaved).toBeGreaterThan(0)
    expect(finding!.fix.type).toBe('paste')
  })

  it('stays quiet when fewer than 3 projects load the server', () => {
    const sessions = [
      makeSession(0, {
        project: 'proj-hot',
        turns: [makeTurn(0, { calls: [makeCall(0, { mcpTools: ['mcp__db__tool0'] })] })],
        mcpInventory: serverTools,
        mcpBreakdown: { db: { calls: 2 } },
      }),
      makeSession(1, {
        project: 'proj-cold-a',
        turns: [makeTurn(1, { calls: [makeCall(1, { cacheCreation: 10000 })] })],
        mcpInventory: serverTools,
      }),
    ]
    const projects = groupByProject(sessions)
    expect(detectMcpProfileAdvisor(projects)).toBeNull()
  })

  it('stays quiet when invocations are spread across projects', () => {
    const sessions = [
      makeSession(0, {
        project: 'proj-a',
        turns: [makeTurn(0, { calls: [makeCall(0, { mcpTools: ['mcp__db__tool0'] })] })],
        mcpInventory: serverTools,
        mcpBreakdown: { db: { calls: 1 } },
      }),
      makeSession(1, {
        project: 'proj-b',
        turns: [makeTurn(1, { calls: [makeCall(1, { mcpTools: ['mcp__db__tool1'] })] })],
        mcpInventory: serverTools,
        mcpBreakdown: { db: { calls: 1 } },
      }),
      makeSession(2, {
        project: 'proj-c',
        turns: [makeTurn(2, { calls: [makeCall(2, { mcpTools: ['mcp__db__tool2'] })] })],
        mcpInventory: serverTools,
        mcpBreakdown: { db: { calls: 1 } },
      }),
    ]
    const projects = groupByProject(sessions)
    expect(detectMcpProfileAdvisor(projects)).toBeNull()
  })
})

describe('detectCapabilityReliability', () => {
  it('flags capabilities whose edit turns are retry-heavy', () => {
    const retryTurn = (i: number) =>
      makeTurn(i, {
        calls: [makeCall(i, { skills: ['data-fetch'], input: 1000, output: 500, cost: 1 })],
        hasEdits: true,
        retries: 1,
      })
    const cleanTurn = (i: number) =>
      makeTurn(i, {
        calls: [makeCall(i, { skills: ['data-fetch'], input: 1000, output: 500, cost: 1 })],
        hasEdits: true,
        retries: 0,
      })
    // 6 edit turns, 4 retried → retry rate 0.67.
    const session = makeSession(0, {
      turns: [retryTurn(0), retryTurn(1), retryTurn(2), retryTurn(3), cleanTurn(4), cleanTurn(5)],
      cost: 6,
      input: 6000,
      output: 3000,
    })
    const finding = detectCapabilityReliability(groupByProject([session]))
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('retry-heavy-capabilities')
    expect(finding!.explanation).toContain('data-fetch')
  })
})

describe('findLowWorthCandidates / detectLowWorthSessions', () => {
  it('flags expensive sessions with no edit turns', () => {
    const session = makeSession(0, {
      turns: [makeTurn(0, { calls: [makeCall(0, { cost: 5 })], hasEdits: false })],
      cost: 5,
      input: 1000,
      categories: ALL_ZERO_CATEGORIES(),
    })
    const candidates = findLowWorthCandidates(groupByProject([session]))
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.reasons).toContain('no edit turns')

    const finding = detectLowWorthSessions(groupByProject([session]))
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('low-worth-sessions')
  })

  it('skips cheap sessions and sessions with a delivery command', () => {
    const cheap = makeSession(0, {
      turns: [makeTurn(0, { calls: [makeCall(0, { cost: 0.5 })] })],
      cost: 0.5,
    })
    const delivered = makeSession(1, {
      turns: [makeTurn(1, { calls: [makeCall(1, { cost: 5 })] })],
      cost: 5,
      bashBreakdown: { 'git commit -m "done"': { calls: 1 } },
      categories: ALL_ZERO_CATEGORIES(),
    })
    expect(findLowWorthCandidates(groupByProject([cheap, delivered]))).toEqual([])
  })
})

describe('findContextBloatCandidates / detectContextBloat', () => {
  it('flags sessions with huge input/cache vs output', () => {
    const session = makeSession(0, {
      turns: [makeTurn(0, { calls: [makeCall(0, { input: 100_000, output: 1_000, cacheRead: 0 })] })],
      input: 100_000,
      output: 1_000,
      cacheRead: 0,
    })
    const candidates = findContextBloatCandidates(groupByProject([session]))
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.effectiveInputTokens).toBe(100_000)

    const finding = detectContextBloat(groupByProject([session]))
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('context-heavy-sessions')
  })

  it('respects excluded session ids', () => {
    const session = makeSession(0, {
      turns: [makeTurn(0, { calls: [makeCall(0, { input: 100_000, output: 1_000, cacheRead: 0 })] })],
      input: 100_000,
      output: 1_000,
      cacheRead: 0,
    })
    expect(detectContextBloat(groupByProject([session]), new Set(['sess-0']))).toBeNull()
  })
})

describe('detectSessionOutliers', () => {
  it('flags a session costing far more than its peers', () => {
    const peer = makeSession(0, { turns: [makeTurn(0, { calls: [makeCall(0, { cost: 1 })] })], cost: 1 })
    const peer2 = makeSession(1, { turns: [makeTurn(1, { calls: [makeCall(1, { cost: 1 })] })], cost: 1 })
    const outlier = makeSession(2, { turns: [makeTurn(2, { calls: [makeCall(2, { cost: 10 })] })], cost: 10 })
    const finding = detectSessionOutliers(groupByProject([peer, peer2, outlier]))
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('cost-outliers')
    expect(finding!.explanation).toContain('sess-2')
  })

  it('stays quiet with too few sessions to establish a baseline', () => {
    const peer = makeSession(0, { turns: [makeTurn(0, { calls: [makeCall(0, { cost: 1 })] })], cost: 1 })
    const outlier = makeSession(1, { turns: [makeTurn(1, { calls: [makeCall(1, { cost: 10 })] })], cost: 10 })
    expect(detectSessionOutliers(groupByProject([peer, outlier]))).toBeNull()
  })
})

describe('ghost detectors (agents / skills / commands)', () => {
  it('detectGhostAgents flags defined agents that were never invoked', () => {
    const finding = detectGhostAgents(['reviewer'], ['architect', 'reviewer'])
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('unused-agents')
    expect(finding!.explanation).toContain('architect')
    expect(finding!.fix.type).toBe('paste')
  })

  it('detectGhostSkills flags defined skills that were never invoked', () => {
    const finding = detectGhostSkills(['reviewer'], ['debugger', 'reviewer'])
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('unused-skills')
    expect(finding!.explanation).toContain('debugger')
  })

  it('detectGhostCommands flags defined commands never referenced', () => {
    const finding = detectGhostCommands(['please run /summarize now'], ['fix', 'summarize'])
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('unused-commands')
    expect(finding!.explanation).toContain('fix')
  })

  it('returns null when there are no definitions', () => {
    expect(detectGhostAgents(['x'], [])).toBeNull()
    expect(detectGhostSkills(['x'], [])).toBeNull()
    expect(detectGhostCommands(['/x'], [])).toBeNull()
  })
})

describe('deferral-gap detectors', () => {
  it.each([undefined, 'false'])('requires review before changing a tool-search setting of %s', deferSetting => {
    const projects = groupByProject(
      [0, 1].map(index =>
        makeSession(index, {
          turns: [makeTurn(index, { calls: [makeCall(index)] })],
          apiCalls: 1,
        }),
      ),
    )
    const finding = detectMcpDeferralOff(
      readSteps(projects),
      projects,
      optimizeSetup({
        configured: ['filesystem'],
        deferSetting,
      }),
    )
    expect(finding?.fix).toMatchObject({ type: 'paste', destination: 'prompt' })
    expect(finding?.explanation).toContain('do not establish that deferral was disabled')
    if (finding?.fix.type === 'paste') {
      expect(finding.fix.text).toContain('installed Claude Code version')
      expect(finding.fix.text).not.toContain('export ENABLE_TOOL_SEARCH')
      expect(finding.fix.text).not.toContain('Remove the')
    }
  })

  it('detectMcpDeferralOff reports inactive tool deferral for configured servers', () => {
    const session = makeSession(0, {
      turns: [makeTurn(0, { calls: [makeCall(0, {})] })],
      cost: 1,
      apiCalls: 1,
    })
    const session2 = makeSession(1, {
      turns: [makeTurn(1, { calls: [makeCall(1, {})] })],
      cost: 1,
      apiCalls: 1,
    })
    const projects = groupByProject([session, session2])
    const steps = readSteps(projects)
    const finding = detectMcpDeferralOff(steps, projects, optimizeSetup({ configured: ['filesystem'] }))
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('mcp-deferral-off')
  })

  it('detectMcpDeferralOff is silent when ToolSearch is observed', () => {
    const session = makeSession(0, {
      turns: [makeTurn(0, { calls: [makeCall(0, { toolSequence: [[{ tool: 'ToolSearch' }]] })] })],
      apiCalls: 1,
    })
    const session2 = makeSession(1, {
      turns: [makeTurn(1, { calls: [makeCall(1, { toolSequence: [[{ tool: 'ToolSearch' }]] })] })],
      apiCalls: 1,
    })
    const projects = groupByProject([session, session2])
    const steps = readSteps(projects)
    expect(detectMcpDeferralOff(steps, projects, optimizeSetup({ configured: ['filesystem'] }))).toBeNull()
  })

  it('detectMcpAlwaysLoadHygiene flags rarely-invoked alwaysLoad servers', () => {
    const session = makeSession(0, { turns: [makeTurn(0, { calls: [makeCall(0, {})] })], apiCalls: 1 })
    const projects = groupByProject([session])
    const finding = detectMcpAlwaysLoadHygiene(
      projects,
      optimizeSetup({ configured: ['filesystem'], alwaysLoad: ['filesystem'] }),
    )
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('mcp-alwaysload-hygiene')
  })

  it('detectMcpDeferThreshold suggests tightening an over-generous auto threshold', () => {
    const session = makeSession(0, {
      turns: [makeTurn(0, { calls: [makeCall(0, {})] })],
      apiCalls: 1,
      mcpBreakdown: { filesystem: { calls: 1 }, github: { calls: 1 }, memory: { calls: 1 } },
    })
    const projects = groupByProject([session])
    const finding = detectMcpDeferThreshold(
      projects,
      optimizeSetup({ configured: ['filesystem', 'github', 'memory'], deferSetting: 'auto:90' }),
    )
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('mcp-defer-threshold')
  })
})

describe('Optimize populations and evidence', () => {
  function payloadFor(sessions: SessionSummary[], scope: OverviewScope = { period: 'lifetime' }): OptimizePayload {
    const setup = {
      ...optimizeSetup(),
      agents: ['unseen-agent'],
      skills: ['unseen-skill'],
      commands: ['unseen-command'],
    }
    return calculateOptimizePayload(groupByProject(sessions), scope, setup, NOW)
  }

  it('does not inspect Claude definitions against Codex-only activity', () => {
    const session = makeSession(0, { turns: [makeTurn(0, { calls: [makeCall(0, { provider: 'codex' })] })] })
    const payload = payloadFor([session], { period: 'lifetime', provider: 'codex' })
    expect(payload.findings.filter(f => f.id.startsWith('unused-'))).toEqual([])
    expect(payload.summary.setupCoverage).toEqual({ eligibleSessions: 0, observedSessions: 0 })
    expect(payload.summary.healthGrade).toBeNull()
  })

  it('keeps sidechain spend but excludes it from human behavior diagnostics', () => {
    const session = makeSession(0, {
      turns: [makeTurn(0, { calls: [makeCall(0, { cost: 20, input: 300_000, output: 1 })], hasEdits: false })],
      categories: ALL_ZERO_CATEGORIES(),
    })
    const payload = payloadFor([{ ...session, isSidechain: true }])
    expect(payload.summary).toMatchObject({
      periodCostUSD: 20,
      sessions: 1,
      behaviorSessions: 0,
      excludedSidechainSessions: 1,
    })
    expect(payload.findings.some(f => f.id === 'low-worth-sessions' || f.id === 'context-heavy-sessions')).toBe(false)
    expect(payload.findings.find(f => f.id === 'unused-agents')).toMatchObject({
      associatedSpendUSD: null,
      affectedSessions: [],
    })
  })

  it('keeps the source identity of affected sessions with identical public ids', () => {
    const turns = [makeTurn(0, { calls: [makeCall(0, { cost: 8 })], hasEdits: false })]
    const sessions = [1, 2].map(sourceId => ({
      ...makeSession(0, { turns, categories: ALL_ZERO_CATEGORIES() }),
      sourceId,
    }))
    const finding = payloadFor(sessions).findings.find(f => f.id === 'low-worth-sessions')!
    expect(finding.affectedSessions.map(s => s.key)).toEqual(['1:sess-0', '2:sess-0'])
    expect(finding.associatedSpendUSD).toBe(16)
  })

  it('does not turn writes of new files into evidence of too few reads', () => {
    const steps = Array.from({ length: 20 }, () => ({
      name: 'Write',
      filePath: '/src/new.ts',
      project: 'p',
      sessionId: 's',
      recent: false,
    }))
    expect(detectLowReadEditRatio(steps)).toBeNull()
  })

  it('permits dependency source and required instruction reads', () => {
    const steps = ['node_modules/effect/AGENTS.md', 'node_modules/effect/src/Effect.ts', 'node_modules/x/SKILL.md'].map(
      file => ({ name: 'Read', filePath: `/p/${file}`, project: 'p', sessionId: 's', recent: false }),
    )
    expect(detectJunkReads(steps)).toBeNull()
  })

  it('resets reread evidence after a recorded edit to the same file', () => {
    const read = { name: 'Read', filePath: '/p/src/a.ts', project: 'p', sessionId: 's', recent: false }
    const steps = Array.from({ length: 10 }, () => [read, { ...read, name: 'Edit' }]).flat()
    expect(detectDuplicateReads(steps)).toBeNull()
    expect(detectDuplicateReads(Array.from({ length: 6 }, () => read))).not.toBeNull()
  })

  it('does not infer cache reuse from missing all-zero counters', () => {
    const session = makeSession(0, { turns: [], apiCalls: 20, input: 100_000, cacheRead: 0, cacheWrite: 0 })
    expect(detectLowCacheReuse(groupByProject([session]))).toBeNull()
    const finding = detectLowCacheReuse(groupByProject([{ ...session, totalCacheWriteTokens: 20_000 }]))
    expect(finding).toMatchObject({ id: 'low-cache-reuse', quantity: { value: 20, unit: 'calls' } })
  })

  it('does not flag identical cache-write calls using unrelated session totals', () => {
    const calls = Array.from({ length: 10 }, () => ({ cacheCreationTokens: 100_000, version: '' }))
    expect(detectCacheBloat(calls, [])).toBeNull()
  })

  it('reports explicit error and interruption observations without recovery estimates', () => {
    const call = { ...makeCall(0, { cost: 4 }), toolErrors: 2, editFailed: 1, interrupted: true }
    const session = makeSession(0, { turns: [makeTurn(0, { calls: [call] })] })
    const payload = payloadFor([session])
    for (const id of ['tool-failures', 'interrupted-calls']) {
      expect(payload.findings.find(f => f.id === id)).toMatchObject({
        basis: 'observed',
        quantity: { value: 1, unit: 'calls' },
        estimatedSavingsUSD: null,
        associatedSpendUSD: 4,
      })
    }
  })
})

describe('Optimize comparability and coverage', () => {
  it('uses raw cache-token volume without a universal cache price discount', () => {
    const session = makeSession(0, {
      turns: [makeTurn(0, { calls: [makeCall(0, { input: 0, output: 1000, cacheRead: 100_000 })] })],
    })
    expect(findContextBloatCandidates(groupByProject([session]))[0]).toMatchObject({
      effectiveInputTokens: 100_000,
      ratio: 100,
    })
  })

  it('does not compare a costly session with peers from a different provider', () => {
    const sessions = ['claude', 'claude', 'codex'].map((provider, i) =>
      makeSession(i, {
        turns: [makeTurn(i, { calls: [makeCall(i, { provider, cost: i === 2 ? 20 : 1 })] })],
      }),
    )
    expect(detectSessionOutliers(groupByProject(sessions))).toBeNull()
  })

  it('keeps behavioral and current-definition findings out of observed setup health', () => {
    const sessions = [0, 1].map(i =>
      makeSession(i, {
        turns: [makeTurn(i, { calls: [makeCall(i, { cost: 12, input: 100_000, output: 1 })], hasEdits: false })],
        categories: ALL_ZERO_CATEGORIES(),
        mcpInventory: ['mcp__example__inspect'],
      }),
    )
    const payload = calculateOptimizePayload(
      groupByProject(sessions),
      { period: 'lifetime' },
      { ...optimizeSetup(), agents: ['unseen'] },
      NOW,
    )
    expect(payload.summary).toMatchObject({
      healthScore: 100,
      healthGrade: 'A',
      setupCoverage: { eligibleSessions: 2, observedSessions: 2 },
    })
    expect(payload.findings.find(f => f.id === 'low-worth-sessions')?.findingClass).toBe('information')
    expect(payload.findings.find(f => f.id === 'unused-agents')?.affectedSessions).toEqual([])
  })
})
