import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LedgerStore } from '../src/main/store/ledger.js'
import type {
  ClassifiedTurn,
  ParsedApiCall,
  ProjectSummary,
  SessionSummary,
  TokenUsage,
  ToolCall,
} from '../src/main/pipeline/types.js'
import type { CachedCall, CachedFile } from '../src/main/pipeline/session-cache.js'
import { buildFixtureReport } from './fixtures/report.js'
import { buildFixtureCachedFile, buildFixtureCachedTurn, buildFixtureCachedCall } from './fixtures/cached-file.js'
import { buildSessionSummary, cachedTurnToClassified } from '../src/main/pipeline/parser.js'
import {
  aggregateMcpCoverage,
  buildOptimizeViewFromLedger,
  computeHealth,
  computeInputCostRate,
  computeTrend,
  detectCacheBloat,
  detectCapabilityReliability,
  detectContextBloat,
  detectDuplicateReads,
  detectGhostAgents,
  detectGhostCommands,
  detectGhostSkills,
  detectJunkReads,
  detectLowReadEditRatio,
  detectMcpAlwaysLoadHygiene,
  detectMcpDeferralOff,
  detectMcpDeferThreshold,
  detectMcpProfileAdvisor,
  detectMcpToolCoverage,
  detectSessionOutliers,
  detectLowWorthSessions,
  findContextBloatCandidates,
  findLowWorthCandidates,
  formatTokens,
  type FindingId,
  type WasteAction,
} from '../src/main/optimize-view.js'

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

function readSteps(projects: ProjectSummary[]) {
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

// ── Ledger-backed Optimize view (map 06) ───────────────────────────────────

function optMakeLedger(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'tr-opt-'))
  return new LedgerStore(join(dir, 'data.db'))
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

function optPort(store: LedgerStore, files: CachedFile[]): void {
  files.forEach((file, i) => {
    store.portIn({
      provider: 'claude',
      envFingerprint: 'env-demo',
      filePath: `/cache/claude/${file.turns[0]?.sessionId ?? `sess-${i}`}.jsonl`,
      verdict: 'new',
      cachedFile: file,
    })
  })
}

describe('buildOptimizeViewFromLedger (aggregation seam scope)', () => {
  it('returns an empty A-grade payload for an empty ledger', async () => {
    const store = optMakeLedger()
    const payload = await buildOptimizeViewFromLedger(store, { period: 'lifetime' }, { now: NOW, homeDir: tempHome() })
    expect(payload.findings).toEqual([])
    expect(payload.summary).toMatchObject({
      healthScore: 100,
      healthGrade: 'A',
      findingCount: 0,
      sessions: 0,
      calls: 0,
    })
    expect(payload.period.start).not.toBeNull()
    store.close()
  })

  it('runs the read detectors over the ledger toolSequence and reports junk reads', async () => {
    const file = optCachedFile(0, {
      sessionId: 'sess-o0',
      cost: 5,
      toolSequence: [
        [{ tool: 'Read', file: '/tmp/demo/node_modules/a/index.js' }],
        [{ tool: 'Read', file: '/tmp/demo/dist/b.js' }],
        [{ tool: 'Read', file: '/tmp/demo/node_modules/c/lib.js' }],
      ],
    })
    const store = optMakeLedger()
    optPort(store, [file])
    const payload = await buildOptimizeViewFromLedger(store, { period: 'lifetime' }, { now: NOW, homeDir: tempHome() })

    const junk = payload.findings.find(f => f.id === 'build-folder-reads')
    expect(junk).toBeDefined()
    expect(junk!.severity).toBe('low')
    expect(junk!.tokensSaved).toBe(3 * 600)
    expect(payload.summary.findingCount).toBeGreaterThanOrEqual(1)
    expect(payload.summary.potentialSavingsTokens).toBeGreaterThan(0)
    expect(payload.summary.periodCostUSD).toBe(5)
    store.close()
  })

  it('honors the custom-range scope at the SQL read', async () => {
    const inRange = optCachedFile(0, { sessionId: 'sess-o1', date: '2026-07-13', cost: 1 })
    const outRange = optCachedFile(1, { sessionId: 'sess-o2', date: '2026-07-14', cost: 2 })
    const store = optMakeLedger()
    optPort(store, [inRange, outRange])
    const payload = await buildOptimizeViewFromLedger(
      store,
      { period: 'lifetime', range: { since: '2026-07-12', until: '2026-07-13' } },
      { now: NOW, homeDir: tempHome() },
    )
    expect(payload.summary.sessions).toBe(1)
    expect(payload.summary.calls).toBe(1)
    store.close()
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
  it('classifies active vs improving vs resolved', () => {
    expect(
      computeTrend({
        recentCount: 0,
        recentWindowMs: 1000,
        baselineCount: 0,
        baselineWindowMs: 1000,
        hasRecentActivity: true,
      }),
    ).toBe('active')
    expect(
      computeTrend({
        recentCount: 0,
        recentWindowMs: 1000,
        baselineCount: 5,
        baselineWindowMs: 1000,
        hasRecentActivity: true,
      }),
    ).toBe('resolved')
    // No recent activity keeps the finding active (no signal to downgrade).
    expect(
      computeTrend({
        recentCount: 0,
        recentWindowMs: 1000,
        baselineCount: 5,
        baselineWindowMs: 1000,
        hasRecentActivity: false,
      }),
    ).toBe('active')
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

describe('computeInputCostRate', () => {
  it('returns 0 for empty or free input', () => {
    expect(computeInputCostRate([])).toBe(0)
    const session = makeSession(0, {
      turns: [makeTurn(0, { calls: [makeCall(0, { cost: 0 })] })],
      cost: 0,
      input: 1000,
    })
    expect(computeInputCostRate(groupByProject([session]))).toBe(0)
  })

  it('estimates input cost per token from 70% of total spend', () => {
    const session = makeSession(0, {
      turns: [makeTurn(0, { calls: [makeCall(0, { cost: 10, input: 1000, output: 0 })] })],
      cost: 10,
      input: 1000,
    })
    // 70% of $10 across 1000 input+read+write tokens.
    expect(computeInputCostRate(groupByProject([session]))).toBeCloseTo(0.007)
  })
})

describe('detectJunkReads', () => {
  it('flags reads into build/dependency folders once past the threshold', () => {
    const steps = [
      { name: 'Read', filePath: '/tmp/demo/node_modules/a/index.js', sessionId: 's', project: 'p', recent: false },
      { name: 'Read', filePath: '/tmp/demo/dist/b.js', sessionId: 's', project: 'p', recent: false },
      { name: 'Read', filePath: '/tmp/demo/node_modules/c/lib.js', sessionId: 's', project: 'p', recent: false },
    ]
    const finding = detectJunkReads(steps, undefined, NOW)
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('build-folder-reads')
    expect(finding!.tokensSaved).toBe(3 * 600)
    expect(finding!.fix.type).toBe('paste')
  })

  it('stays quiet under the minimum count', () => {
    const steps = [
      { name: 'Read', filePath: '/tmp/demo/node_modules/a/index.js', sessionId: 's', project: 'p', recent: false },
      { name: 'Read', filePath: '/tmp/demo/dist/b.js', sessionId: 's', project: 'p', recent: false },
    ]
    expect(detectJunkReads(steps, undefined, NOW)).toBeNull()
  })

  it('normalizes Windows backslash paths', () => {
    const steps = [
      { name: 'Read', filePath: 'C:/demo/node_modules/a/index.js', sessionId: 's', project: 'p', recent: false },
      { name: 'Read', filePath: 'C:/demo/dist/b.js', sessionId: 's', project: 'p', recent: false },
      { name: 'Read', filePath: 'C:/demo/node_modules/c/lib.js', sessionId: 's', project: 'p', recent: false },
    ]
    const finding = detectJunkReads(steps, undefined, NOW)
    expect(finding?.explanation).toContain('node_modules/')
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
      filePath: '/tmp/demo/node_modules/pkg/index.js',
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
  it('flags sessions whose warmup is far above the baseline', () => {
    const apiCalls = Array.from({ length: 10 }, () => ({ cacheCreationTokens: 100_000, version: '', recent: false }))
    const projects = groupByProject([
      makeSession(0, {
        turns: [makeTurn(0, { calls: [makeCall(0, { cacheCreation: 100_000 })] })],
        cacheWrite: 100_000,
      }),
    ])
    const finding = detectCacheBloat(apiCalls, projects, undefined, NOW)
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('warmup-heavy')
    // baseline = 50_000 default; median 100_000 > 1.4 * 50_000 = 70_000.
    expect(finding!.tokensSaved).toBe((100_000 - 50_000) * 10)
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
  it('detectGhostAgents flags agent files never invoked', async () => {
    const home = tempHome()
    mkdirSync(join(home, '.claude', 'agents'), { recursive: true })
    writeFileSync(join(home, '.claude', 'agents', 'architect.md'), '')
    writeFileSync(join(home, '.claude', 'agents', 'reviewer.md'), '')
    const finding = await detectGhostAgents(['reviewer'], home)
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('unused-agents')
    expect(finding!.explanation).toContain('architect')
    expect(finding!.fix.type).toBe('command')
  })

  it('detectGhostSkills flags skill dirs never invoked', async () => {
    const home = tempHome()
    mkdirSync(join(home, '.claude', 'skills', 'debugger'), { recursive: true })
    mkdirSync(join(home, '.claude', 'skills', 'reviewer'), { recursive: true })
    writeFileSync(join(home, '.claude', 'skills', 'debugger', 'SKILL.md'), '')
    writeFileSync(join(home, '.claude', 'skills', 'reviewer', 'SKILL.md'), '')
    const finding = await detectGhostSkills(['reviewer'], home)
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('unused-skills')
    expect(finding!.explanation).toContain('debugger')
  })

  it('detectGhostCommands flags slash commands never referenced', async () => {
    const home = tempHome()
    mkdirSync(join(home, '.claude', 'commands'), { recursive: true })
    writeFileSync(join(home, '.claude', 'commands', 'fix.md'), '')
    writeFileSync(join(home, '.claude', 'commands', 'summarize.md'), '')
    const finding = await detectGhostCommands(['please run /summarize now'], home)
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('unused-commands')
    expect(finding!.explanation).toContain('fix')
  })

  it('returns null when the home dir has no definitions', async () => {
    const home = tempHome()
    expect(await detectGhostAgents(['x'], home)).toBeNull()
    expect(await detectGhostSkills(['x'], home)).toBeNull()
    expect(await detectGhostCommands(['/x'], home)).toBeNull()
  })
})

describe('deferral-gap detectors', () => {
  it('detectMcpDeferralOff reports inactive tool deferral for configured servers', () => {
    const home = tempHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ mcpServers: { filesystem: {} } }))

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
    const cwds = new Set(projects.map(p => p.projectPath))
    const finding = detectMcpDeferralOff(steps, projects, cwds, home)
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('mcp-deferral-off')
  })

  it('detectMcpDeferralOff is silent when ToolSearch is observed', () => {
    const home = tempHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ mcpServers: { filesystem: {} } }))

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
    const cwds = new Set(projects.map(p => p.projectPath))
    expect(detectMcpDeferralOff(steps, projects, cwds, home)).toBeNull()
  })

  it('detectMcpAlwaysLoadHygiene flags rarely-invoked alwaysLoad servers', () => {
    const home = tempHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { filesystem: { alwaysLoad: true } } }),
    )
    const session = makeSession(0, { turns: [makeTurn(0, { calls: [makeCall(0, {})] })], apiCalls: 1 })
    const projects = groupByProject([session])
    const cwds = new Set(projects.map(p => p.projectPath))
    const finding = detectMcpAlwaysLoadHygiene(projects, cwds, undefined, home)
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('mcp-alwaysload-hygiene')
  })

  it('detectMcpDeferThreshold suggests tightening an over-generous auto threshold', () => {
    const home = tempHome()
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(
      join(home, '.claude', 'settings.local.json'),
      JSON.stringify({
        env: { ENABLE_TOOL_SEARCH: 'auto:90' },
        mcpServers: { filesystem: {}, github: {}, memory: {} },
      }),
    )
    const session = makeSession(0, {
      turns: [makeTurn(0, { calls: [makeCall(0, {})] })],
      apiCalls: 1,
      mcpBreakdown: { filesystem: { calls: 1 }, github: { calls: 1 }, memory: { calls: 1 } },
    })
    const projects = groupByProject([session])
    const cwds = new Set(projects.map(p => p.projectPath))
    const finding = detectMcpDeferThreshold(projects, cwds, home)
    expect(finding).not.toBeNull()
    expect(finding!.id).toBe('mcp-defer-threshold')
  })
})
