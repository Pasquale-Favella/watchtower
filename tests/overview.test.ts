import { describe, expect, it } from 'vitest'
import { buildOverviewPayload, dataStartForSessions, periodWindowStart, type OverviewPayload, type OverviewScope } from '../src/main/overview.js'
import type { ProjectSummary, SessionSummary, TaskCategory, TokenUsage } from '../src/main/pipeline/types.js'

const CATEGORIES: TaskCategory[] = [
  'coding', 'debugging', 'feature', 'refactoring', 'testing', 'exploration',
  'planning', 'delegation', 'git', 'build/deploy', 'conversation', 'brainstorming', 'general'
]

/** Local-constructed ISO timestamp: both the fixture and the builder interpret
 * dates in the machine's local timezone, so assertions stay timezone-robust. */
function ts(y: number, m: number, d: number, h: number): string {
  return new Date(y, m - 1, d, h, 0, 0).toISOString()
}

function zeroTokens(): TokenUsage {
  return {
    inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0, webSearchRequests: 0
  }
}

function tokens(input: number, output: number, cacheRead = 0, reasoning = 0): TokenUsage {
  return { ...zeroTokens(), inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, reasoningTokens: reasoning }
}

function zeroedCategoryBreakdown(): SessionSummary['categoryBreakdown'] {
  const empty = { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 }
  return Object.fromEntries(CATEGORIES.map(category => [category, { ...empty }])) as SessionSummary['categoryBreakdown']
}

/**
 * Three sessions spanning 2026-07-01..2026-07-03 across two providers:
 *  - sess1: opencode/demo-model, one one-shot coding edit turn (cost 0.50)
 *  - sess2: claude/Sonnet 4.5, an edit turn that retried (cost 1.20) plus a
 *    follow-up "that's not what I meant" correction turn (cost 0.30), an MCP
 *    tool, a skill, a subagent, and a reworked file
 *  - sess3: opencode/demo-model local-model savings call (cost $0, saved 0.80)
 * Breakdowns are keyed with the SHORT model names / mcp server ids the parser's
 * buildSessionSummary would produce, so re-slicing via filterProjectsByDateRange
 * is idempotent.
 */
function buildOverviewFixture(): ProjectSummary[] {
  const sess1: SessionSummary = {
    sessionId: 'sess1',
    project: 'demo-app',
    firstTimestamp: ts(2026, 7, 1, 10),
    lastTimestamp: ts(2026, 7, 1, 10),
    totalCostUSD: 0.5,
    totalSavingsUSD: 0,
    totalEstimatedCostUSD: 0,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalReasoningTokens: 5,
    totalCacheReadTokens: 20,
    totalCacheWriteTokens: 0,
    apiCalls: 1,
    turns: [{
      userMessage: 'prompt for sess1',
      timestamp: ts(2026, 7, 1, 10),
      sessionId: 'sess1',
      category: 'coding',
      retries: 0,
      hasEdits: true,
      assistantCalls: [{
        provider: 'opencode', model: 'demo-model', usage: tokens(100, 50, 20, 5),
        costUSD: 0.5, tools: ['Edit'], mcpTools: [], skills: ['refactor'], subagentTypes: [],
        hasAgentSpawn: false, hasPlanMode: false, speed: 'standard',
        timestamp: ts(2026, 7, 1, 10), bashCommands: [], deduplicationKey: 'd1'
      }]
    }],
    modelBreakdown: { 'demo-model': { calls: 1, costUSD: 0.5, savingsUSD: 0, tokens: tokens(100, 50, 20, 5) } },
    toolBreakdown: { Edit: { calls: 1 } },
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {
      ...zeroedCategoryBreakdown(),
      coding: { turns: 1, costUSD: 0.5, savingsUSD: 0, retries: 0, editTurns: 1, oneShotTurns: 1 }
    },
    skillBreakdown: { refactor: { turns: 1, costUSD: 0.5, savingsUSD: 0, editTurns: 1, oneShotTurns: 1 } },
    subagentBreakdown: {}
  }

  const sess2: SessionSummary = {
    sessionId: 'sess2',
    project: 'demo-app',
    firstTimestamp: ts(2026, 7, 2, 9),
    lastTimestamp: ts(2026, 7, 2, 10),
    totalCostUSD: 1.5,
    totalSavingsUSD: 0,
    totalEstimatedCostUSD: 0,
    totalInputTokens: 200,
    totalOutputTokens: 100,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 40,
    totalCacheWriteTokens: 0,
    apiCalls: 2,
    turns: [
      {
        userMessage: 'add a widget',
        timestamp: ts(2026, 7, 2, 9),
        sessionId: 'sess2',
        category: 'feature',
        retries: 1,
        hasEdits: true,
        assistantCalls: [{
          provider: 'claude', model: 'claude-sonnet-4.5', usage: tokens(100, 50, 20),
          costUSD: 1.2, tools: ['Write'], mcpTools: ['mcp__github__list_prs'], skills: ['refactor-helper'],
          subagentTypes: ['general-purpose'], hasAgentSpawn: false, hasPlanMode: false, speed: 'standard',
          timestamp: ts(2026, 7, 2, 9), bashCommands: [], deduplicationKey: 'd2',
          toolSequence: [[{ tool: 'Write', file: '/tmp/demo-app/src/widget.tsx' }]]
        }]
      },
      {
        userMessage: "that's not what I meant",
        timestamp: ts(2026, 7, 2, 10),
        sessionId: 'sess2',
        category: 'debugging',
        retries: 0,
        hasEdits: false,
        assistantCalls: [{
          provider: 'claude', model: 'claude-sonnet-4.5', usage: tokens(100, 50, 20),
          costUSD: 0.3, tools: [], mcpTools: [], skills: [], subagentTypes: [],
          hasAgentSpawn: false, hasPlanMode: false, speed: 'standard',
          timestamp: ts(2026, 7, 2, 10), bashCommands: [], deduplicationKey: 'd3'
        }]
      }
    ],
    modelBreakdown: { 'Sonnet 4.5': { calls: 2, costUSD: 1.5, savingsUSD: 0, tokens: tokens(200, 100, 40) } },
    toolBreakdown: { Write: { calls: 1 } },
    mcpBreakdown: { github: { calls: 1 } },
    bashBreakdown: {},
    categoryBreakdown: {
      ...zeroedCategoryBreakdown(),
      feature: { turns: 1, costUSD: 1.2, savingsUSD: 0, retries: 1, editTurns: 1, oneShotTurns: 0 },
      debugging: { turns: 1, costUSD: 0.3, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 }
    },
    skillBreakdown: { 'refactor-helper': { turns: 1, costUSD: 1.2, savingsUSD: 0, editTurns: 1, oneShotTurns: 0 } },
    subagentBreakdown: { 'general-purpose': { calls: 1, costUSD: 1.2, savingsUSD: 0 } }
  }

  const sess3: SessionSummary = {
    sessionId: 'sess3',
    project: 'demo-app',
    firstTimestamp: ts(2026, 7, 3, 12),
    lastTimestamp: ts(2026, 7, 3, 12),
    totalCostUSD: 0,
    totalSavingsUSD: 0.8,
    totalEstimatedCostUSD: 0,
    totalInputTokens: 300,
    totalOutputTokens: 100,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 1,
    turns: [{
      userMessage: 'refactor for free',
      timestamp: ts(2026, 7, 3, 12),
      sessionId: 'sess3',
      category: 'coding',
      retries: 0,
      hasEdits: true,
      assistantCalls: [{
        provider: 'opencode', model: 'demo-model', usage: tokens(300, 100, 0),
        costUSD: 0, savingsUSD: 0.8, savingsBaselineModel: 'claude-opus-4-6', isLocalSavings: true,
        tools: ['Edit'], mcpTools: [], skills: [], subagentTypes: [],
        hasAgentSpawn: false, hasPlanMode: false, speed: 'standard',
        timestamp: ts(2026, 7, 3, 12), bashCommands: [], deduplicationKey: 'd4'
      }]
    }],
    modelBreakdown: { 'demo-model': { calls: 1, costUSD: 0, savingsUSD: 0.8, tokens: tokens(300, 100) } },
    toolBreakdown: { Edit: { calls: 1 } },
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {
      ...zeroedCategoryBreakdown(),
      coding: { turns: 1, costUSD: 0, savingsUSD: 0.8, retries: 0, editTurns: 1, oneShotTurns: 1 }
    },
    skillBreakdown: {},
    subagentBreakdown: {}
  }

  return [{
    project: 'demo-app',
    projectPath: '/tmp/demo-app',
    sessions: [sess1, sess2, sess3],
    totalCostUSD: 2.0,
    totalSavingsUSD: 0.8,
    totalEstimatedCostUSD: 0,
    totalApiCalls: 4,
    totalProxiedCostUSD: 0
  }]
}

/** The payload core fed the fixture's sessions (map 05): the report path is
 * gone, so the Overview logic is exercised through the same
 * `buildOverviewPayload` the ledger-backed handler uses. `dataStart` spans the
 * same session set — matching the old unscoped `dataStartFor(report)` for the
 * LIFETIME scope these fixtures always use. */
function payloadFor(projects: ProjectSummary[], scope: OverviewScope, now: Date = NOW): OverviewPayload {
  const sessions = projects.flatMap(project => project.sessions)
  return buildOverviewPayload(sessions, scope, now, dataStartForSessions(sessions))
}

const NOW = new Date(2026, 6, 5, 12, 0, 0)
const LIFETIME: OverviewScope = { period: 'lifetime' }

describe('periodWindowStart', () => {
  it('resolves the reference period window starts', () => {
    expect(periodWindowStart('today', NOW)).toBe('2026-07-05')
    expect(periodWindowStart('week', NOW)).toBe('2026-06-28')
    expect(periodWindowStart('30days', NOW)).toBe('2026-06-05')
    expect(periodWindowStart('month', NOW)).toBe('2026-07-01')
    expect(periodWindowStart('all', NOW)).toBe('2026-01-01')
    expect(periodWindowStart('lifetime', NOW)).toBe('1970-01-01')
  })
})

describe('buildOverview KPI row', () => {
  it('rolls up cost, calls, sessions, tokens, savings, and estimated cost', () => {
    const payload = payloadFor(buildOverviewFixture(), LIFETIME, NOW)

    expect(payload.kpis.cost).toBeCloseTo(2.0, 6)
    expect(payload.kpis.calls).toBe(4)
    expect(payload.kpis.sessions).toBe(3)
    expect(payload.kpis.inputTokens).toBe(600)
    expect(payload.kpis.outputTokens).toBe(250)
    expect(payload.kpis.cacheReadTokens).toBe(60)
    expect(payload.kpis.cacheWriteTokens).toBe(0)
    expect(payload.kpis.savingsUSD).toBeCloseTo(0.8, 6)
    expect(payload.kpis.estimatedCostUSD).toBe(0)
  })

  it('computes the aggregate one-shot rate and cache-hit percent', () => {
    const payload = payloadFor(buildOverviewFixture(), LIFETIME, NOW)

    // 2 one-shot edit turns / 3 edit turns (sess1, sess2 feature retried, sess3)
    expect(payload.kpis.oneShotRate).toBeCloseTo(2 / 3, 6)
    // 60 cache-read / (60 + 600 input)
    expect(payload.kpis.cacheHitPercent).toBeCloseTo(60 / 660 * 100, 6)
  })

  it('returns zeros for an empty report instead of dividing by zero', () => {
    const payload = payloadFor([], LIFETIME, NOW)

    expect(payload.kpis.cost).toBe(0)
    expect(payload.kpis.calls).toBe(0)
    expect(payload.kpis.sessions).toBe(0)
    expect(payload.kpis.oneShotRate).toBeNull()
    expect(payload.kpis.cacheHitPercent).toBe(0)
    expect(payload.daily).toHaveLength(30)
  })
})

describe('buildOverview daily chart', () => {
  it('zero-fills a contiguous 30-day window and keeps real daily spend', () => {
    const payload = payloadFor(buildOverviewFixture(), { period: 'all' }, NOW)

    expect(payload.daily).toHaveLength(30)
    expect(payload.daily[0]).toEqual({ date: '2026-06-06', costUSD: 0, calls: 0, sessions: 0 })
    expect(payload.daily.at(-1)!.date).toBe('2026-07-05')
    const first = payload.daily.find(d => d.date === '2026-07-01')!
    expect(first).toEqual({ date: '2026-07-01', costUSD: 0.5, calls: 1, sessions: 1 })
    expect(payload.daily.find(d => d.date === '2026-07-03')!.costUSD).toBeCloseTo(0, 6)
    expect(payload.daily.find(d => d.date === '2026-07-03')!.calls).toBe(1)
    expect(payload.daily.find(d => d.date === '2026-07-03')!.sessions).toBe(1)
  })

  it('honours an explicit custom range window', () => {
    const payload = payloadFor(buildOverviewFixture(),
      { period: 'lifetime', range: { since: '2026-07-02', until: '2026-07-03' } },
      NOW,
    )

    expect(payload.daily).toHaveLength(2)
    expect(payload.daily[0]).toEqual({ date: '2026-07-02', costUSD: 1.5, calls: 2, sessions: 1 })
    expect(payload.daily[1]).toEqual({ date: '2026-07-03', costUSD: 0, calls: 1, sessions: 1 })
    expect(payload.kpis.cost).toBeCloseTo(1.5, 6)
    expect(payload.kpis.sessions).toBe(2)
  })

  it('extends the chart back to the earliest active day within the period', () => {
    const base = buildOverviewFixture()
    const project = base[0]!
    const old: SessionSummary = {
      ...project.sessions[0]!,
      sessionId: 'old-sess',
      firstTimestamp: ts(2026, 5, 1, 9),
      lastTimestamp: ts(2026, 5, 1, 9),
    }
    const payload = payloadFor([{ ...project, sessions: [...project.sessions, old] }], { period: 'all' }, NOW)

    // 2026-05-01 predates the trailing-30-day default start (2026-06-06), so the
    // window must reach back to it rather than stay a flat 30 days.
    expect(payload.daily[0]).toEqual({ date: '2026-05-01', costUSD: 0.5, calls: 1, sessions: 1 })
    expect(payload.daily.at(-1)!.date).toBe('2026-07-05')
  })

  it('exposes dataStart as the earliest recorded day (null when empty)', () => {
    expect(payloadFor(buildOverviewFixture(), LIFETIME, NOW).dataStart).toBe('2026-07-01')
    expect(payloadFor([], LIFETIME, NOW).dataStart).toBeNull()
  })
})

describe('buildOverview rankings', () => {
  const payload = payloadFor(buildOverviewFixture(), LIFETIME, NOW)

  it('ranks models by cost with token totals and short-name merging', () => {
    expect(payload.models.map(m => m.name)).toEqual(['Sonnet 4.5', 'demo-model'])
    expect(payload.models[0]).toMatchObject({ cost: 1.5, calls: 2, inputTokens: 200, outputTokens: 100, savingsUSD: 0 })
    expect(payload.models[1]).toMatchObject({ cost: 0.5, calls: 2, inputTokens: 400, outputTokens: 150, savingsUSD: 0.8 })
  })

  it('ranks activities by cost with per-category one-shot rates', () => {
    expect(payload.activities.map(a => a.name)).toEqual(['Feature Dev', 'Coding', 'Debugging'])
    expect(payload.activities[0]).toMatchObject({ cost: 1.2, turns: 1, oneShotRate: 0 })
    expect(payload.activities[1]).toMatchObject({ cost: 0.5, turns: 2, oneShotRate: 1 })
    // No edit turns: rate stays null rather than claiming 100%
    expect(payload.activities[2]).toMatchObject({ cost: 0.3, turns: 1, oneShotRate: null })
  })

  it('ranks tools, MCP servers, skills, and subagents', () => {
    expect(payload.tools).toEqual([{ name: 'Edit', calls: 2 }, { name: 'Write', calls: 1 }])
    expect(payload.mcpServers).toEqual([{ name: 'github', calls: 1 }])
    expect(payload.skills).toEqual([
      { name: 'refactor-helper', turns: 1, cost: 1.2 },
      { name: 'refactor', turns: 1, cost: 0.5 }
    ])
    expect(payload.subagents).toEqual([{ name: 'general-purpose', calls: 1, cost: 1.2 }])
  })
})

describe('buildOverview efficiency signals', () => {
  it('computes retry tax from per-model retry spend', () => {
    const payload = payloadFor(buildOverviewFixture(), LIFETIME, NOW)

    // Only Sonnet 4.5 retried (1 retry over its single edit turn at 1.20/edit).
    expect(payload.efficiency.retryTax).toMatchObject({
      totalUSD: 1.2,
      retries: 1,
      editTurns: 1
    })
    expect(payload.efficiency.retryTax.byModel).toHaveLength(1)
    expect(payload.efficiency.retryTax.byModel[0]).toMatchObject({ name: 'Sonnet 4.5', taxUSD: 1.2, retries: 1, retriesPerEdit: 1 })
  })

  it('computes the composite efficiency score and grade', () => {
    const payload = payloadFor(buildOverviewFixture(), LIFETIME, NOW)

    // oneShot 2/3, cacheFrac 60/660, retrySpendFraction 1.2/2 => retryPenalty 1
    const score = 100 * (0.45 * (2 / 3) + 0.30 * (60 / 660) + 0.25 * 0)
    expect(payload.efficiency.score).toBeCloseTo(score, 6)
    expect(payload.efficiency.grade).toBe('F')
  })

  it('returns a neutral score when one-shot data is missing', () => {
    const payload = payloadFor([], LIFETIME, NOW)

    // No data: oneShot falls back to 0.6, cache 0, no retry tax (retry term
    // keeps its full 0.25 weight since there is nothing penalized).
    expect(payload.efficiency.oneShotRate).toBeNull()
    expect(payload.efficiency.score).toBeCloseTo(100 * (0.45 * 0.6 + 0.25), 6)
    expect(payload.efficiency.retryTax.byModel).toEqual([])
  })

  it('computes routing waste against the cheapest reliable model', () => {
    // cheap-model: 5 one-shot edit turns at $0.02/edit (reliable baseline)
    // spendy-model: 2 one-shot edit turns at $1.00/edit
    const cheapCall = (ts: string, key: string): SessionSummary['turns'][number]['assistantCalls'][number] => ({
      provider: 'opencode', model: 'cheap-model', usage: tokens(10, 10),
      costUSD: 0.1, tools: ['Edit'], mcpTools: [], skills: [], subagentTypes: [],
      hasAgentSpawn: false, hasPlanMode: false, speed: 'standard',
      timestamp: ts, bashCommands: [], deduplicationKey: key
    })
    const spendyCall = (ts: string, key: string): SessionSummary['turns'][number]['assistantCalls'][number] => ({
      provider: 'opencode', model: 'spendy-model', usage: tokens(10, 10),
      costUSD: 1.0, tools: ['Edit'], mcpTools: [], skills: [], subagentTypes: [],
      hasAgentSpawn: false, hasPlanMode: false, speed: 'standard',
      timestamp: ts, bashCommands: [], deduplicationKey: key
    })
    const cheapTurns = Array.from({ length: 5 }, (_, i) => ({
      userMessage: `cheap turn ${i}`,
      timestamp: `2026-07-0${i + 1}T09:00:00.000Z`,
      sessionId: `cheap-${i}`,
      category: 'coding' as const,
      retries: 0,
      hasEdits: true,
      assistantCalls: [cheapCall(`2026-07-0${i + 1}T09:00:00.000Z`, `ck${i}`)]
    }))
    const spendyTurns = Array.from({ length: 2 }, (_, i) => ({
      userMessage: `spendy turn ${i}`,
      timestamp: `2026-07-0${i + 1}T10:00:00.000Z`,
      sessionId: `spendy-${i}`,
      category: 'coding' as const,
      retries: 0,
      hasEdits: true,
      assistantCalls: [spendyCall(`2026-07-0${i + 1}T10:00:00.000Z`, `sk${i}`)]
    }))
    const allTurns = [...cheapTurns, ...spendyTurns]
    const breakdown = {
      ...zeroedCategoryBreakdown(),
      coding: {
        turns: allTurns.length,
        costUSD: allTurns.reduce((s, t) => s + t.assistantCalls[0]!.costUSD, 0),
        savingsUSD: 0, retries: 0,
        editTurns: allTurns.length,
        oneShotTurns: allTurns.length
      }
    }
    const session: SessionSummary = {
      sessionId: 'routing-sess', project: 'routing', firstTimestamp: '2026-07-01T09:00:00.000Z',
      lastTimestamp: '2026-07-02T10:00:00.000Z', totalCostUSD: 2.5, totalSavingsUSD: 0,
      totalEstimatedCostUSD: 0, totalInputTokens: 70, totalOutputTokens: 70, totalReasoningTokens: 0,
      totalCacheReadTokens: 0, totalCacheWriteTokens: 0, apiCalls: 7,
      turns: allTurns as SessionSummary['turns'],
      modelBreakdown: {
        'cheap-model': { calls: 5, costUSD: 0.5, savingsUSD: 0, tokens: tokens(50, 50) },
        'spendy-model': { calls: 2, costUSD: 2.0, savingsUSD: 0, tokens: tokens(20, 20) }
      },
      toolBreakdown: { Edit: { calls: 7 } }, mcpBreakdown: {}, bashBreakdown: {},
      categoryBreakdown: breakdown,
      skillBreakdown: {}, subagentBreakdown: {}
    }
    const payload = payloadFor([{
      project: 'routing', projectPath: '/tmp/routing', sessions: [session],
      totalCostUSD: 2.5, totalSavingsUSD: 0, totalEstimatedCostUSD: 0, totalApiCalls: 7, totalProxiedCostUSD: 0
    }], LIFETIME, NOW)

    expect(payload.efficiency.routingWaste.baselineModel).toBe('cheap-model')
    expect(payload.efficiency.routingWaste.baselineCostPerEdit).toBeCloseTo(0.1, 6)
    expect(payload.efficiency.routingWaste.byModel).toHaveLength(1)
    expect(payload.efficiency.routingWaste.byModel[0]).toMatchObject({ name: 'spendy-model', actualUSD: 2.0, counterfactualUSD: 0.2, savingsUSD: 1.8 })
    expect(payload.efficiency.routingWaste.totalSavingsUSD).toBeCloseTo(1.8, 6)
  })

  it('computes workflow stats: corrections, time-to-first-edit, reworked files', () => {
    const payload = payloadFor(buildOverviewFixture(), LIFETIME, NOW)

    // Openers are never corrections; only sess2's follow-up matches a pattern.
    expect(payload.workflow.corrections).toBe(1)
    expect(payload.workflow.userTurns).toBe(4)
    expect(payload.workflow.correctionRate).toBeCloseTo(0.25, 6)
    expect(payload.workflow.medianTimeToFirstEditMs).toBe(0)
    expect(payload.workflow.topReworkedFiles).toEqual([{ path: 'widget.tsx', sessions: 1, edits: 1 }])
  })

  it('reports pricing coverage: unpriced $0-cost models lower the share', () => {
    const base = buildOverviewFixture()
    const session = base[0]!.sessions[0]!
    const unpricedSession: SessionSummary = {
      ...session,
      sessionId: 'unpriced-sess',
      totalCostUSD: 0,
      apiCalls: 1,
      modelBreakdown: {
        'strange-unknown-model-xyz': { calls: 1, costUSD: 0, savingsUSD: 0, tokens: tokens(100, 50) }
      },
      turns: session.turns.map(turn => ({
        ...turn,
        sessionId: 'unpriced-sess',
        assistantCalls: turn.assistantCalls.map(call => ({
          ...call, model: 'strange-unknown-model-xyz', costUSD: 0
        }))
      })),
      categoryBreakdown: { ...zeroedCategoryBreakdown() }
    }
    const projects: ProjectSummary[] = [{ ...base[0]!, sessions: [...base[0]!.sessions, unpricedSession] }]

    const payload = payloadFor(projects, LIFETIME, NOW)

    // 3 cost-bearing model rows (demo-model, Sonnet 4.5, strange-unknown) with
    // calls 2+2+1; the unknown $0 row is the only unpriced one.
    expect(payload.unpricedModels).toEqual([{ model: 'strange-unknown-model-xyz', calls: 1, tokens: 150 }])
    expect(payload.efficiency.pricingCoverage).toBeCloseTo(4 / 5, 6)
  })

  it('reports full coverage when nothing is unpriced', () => {
    const payload = payloadFor(buildOverviewFixture(), LIFETIME, NOW)
    expect(payload.efficiency.pricingCoverage).toBe(1)
    expect(payload.unpricedModels).toEqual([])
  })

  it('rolls up local-model savings by model and provider', () => {
    const payload = payloadFor(buildOverviewFixture(), LIFETIME, NOW)

    expect(payload.localModelSavings).toMatchObject({ totalUSD: 0.8, calls: 1 })
    expect(payload.localModelSavings.byModel).toEqual([{
      name: 'demo-model', calls: 1, actualUSD: 0, savingsUSD: 0.8,
      baselineModel: 'claude-opus-4-6', inputTokens: 300, outputTokens: 100
    }])
    expect(payload.localModelSavings.byProvider).toEqual([{ name: 'opencode', calls: 1, savingsUSD: 0.8 }])
  })
})

describe('buildOverview scoping', () => {
  it('filters by provider at query time', () => {
    const payload = payloadFor(buildOverviewFixture(), { period: 'lifetime', provider: 'opencode' }, NOW)

    expect(payload.kpis.cost).toBeCloseTo(0.5, 6)
    expect(payload.kpis.calls).toBe(2)
    expect(payload.kpis.sessions).toBe(2)
    expect(payload.models.map(m => m.name)).toEqual(['demo-model'])
  })

  it('slices sessions to the selected period window', () => {
    // today = July 2 keeps only sess2 (sess1 on July 1 and sess3 on July 3 fall out).
    const payload = payloadFor(buildOverviewFixture(), { period: 'today' }, new Date(2026, 6, 2, 12, 0, 0))

    expect(payload.kpis.cost).toBeCloseTo(1.5, 6)
    expect(payload.kpis.calls).toBe(2)
    expect(payload.kpis.sessions).toBe(1)
    expect(payload.kpis.oneShotRate).toBe(0)
    expect(payload.models.map(m => m.name)).toEqual(['Sonnet 4.5'])
  })
})
