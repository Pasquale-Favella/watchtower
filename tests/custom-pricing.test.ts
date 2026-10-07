import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import { createLedgerMcpQueryRuntime } from '../src/main/agents/ledger-mcp/query-runtime.js'
import { buildLedgerTools } from '../src/main/agents/ledger-mcp/tools.js'
import { AssistantSetup } from '../src/main/application/assistant-setup.js'
import { queryCompareView } from '../src/main/application/compare-query.js'
import { queryModelsView } from '../src/main/application/models-query.js'
import { queryOptimizeView } from '../src/main/application/optimize-query.js'
import { queryOverview } from '../src/main/application/overview-query.js'
import { querySessionsView } from '../src/main/application/sessions-query.js'
import { querySkillsView } from '../src/main/application/skills-query.js'
import { querySpendView } from '../src/main/application/spend-query.js'
import { findLowWorthCandidates } from '../src/main/optimize-view.js'
import { overviewDateRange } from '../src/main/overview-scope.js'
import { captureLocalModelSavings } from '../src/main/pipeline/models.js'
import type { CachedFile } from '../src/main/pipeline/session-cache.js'
import { collectSkillCandidates } from '../src/main/skills-view.js'
import { defaultRange } from '../src/main/store/aggregate.js'
import {
  type AggregateScope,
  buildSessionSummariesFromSnapshot,
  groupSummariesIntoProjects,
} from '../src/main/store/aggregate-calculation.js'
import { LedgerConfig, LedgerIngest } from '../src/main/store/ledger-ports.js'
import { loadLedgerQuerySnapshotEffect } from '../src/main/store/ledger-query-snapshot.js'
import type { ComparePayload } from '../src/shared/schemas/compare.js'
import type { ModelsPayload } from '../src/shared/schemas/models.js'
import type { OptimizePayload } from '../src/shared/schemas/optimize.js'
import type { OverviewPayload, OverviewScope } from '../src/shared/schemas/overview.js'
import type { SkillsPayload } from '../src/shared/schemas/skills.js'
import type { SpendPayload } from '../src/shared/schemas/spend.js'
import type { SessionRow } from '../src/shared/schemas/views.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'
import { atTime, openLedgerFixture, viewInputs } from './fixtures/ledger-runtime.js'

const NOW = new Date(2026, 6, 15)
const FULL_RANGE = defaultRange(new Date('2026-08-01T00:00:00.000Z'), 60)
const ALL_TIME_RANGE = { start: new Date(-8640000000000000), end: new Date(8640000000000000) }

type TestRuntime = ReturnType<typeof openLedgerFixture>['runtime']

const EMPTY_ASSISTANT_SETUP = AssistantSetup.of({
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

function overviewView(runtime: TestRuntime, scope: OverviewScope): OverviewPayload {
  return runtime.runSync(atTime(queryOverview({ ...viewInputs(scope), localSavings: captureLocalModelSavings() }), NOW))
}

function summariesFor(
  runtime: TestRuntime,
  scope: AggregateScope = { range: FULL_RANGE },
): ReturnType<typeof buildSessionSummariesFromSnapshot> {
  const snapshot = runtime.runSync(loadLedgerQuerySnapshotEffect(viewInputs({ period: 'lifetime' })))
  return buildSessionSummariesFromSnapshot(snapshot, scope)
}

function skillsView(runtime: TestRuntime): Promise<SkillsPayload> {
  const query = querySkillsView({
    ...viewInputs({ period: 'lifetime' }),
    thresholds: { frequency: 1, spread: 1 },
  })
  return runtime.runPromise(atTime(Effect.provideService(query, AssistantSetup, EMPTY_ASSISTANT_SETUP), NOW))
}

function optimizeView(runtime: TestRuntime): Promise<OptimizePayload> {
  const query = queryOptimizeView(viewInputs({ period: 'lifetime' }))
  return runtime.runPromise(atTime(Effect.provideService(query, AssistantSetup, EMPTY_ASSISTANT_SETUP), NOW))
}

function setModelAlias(runtime: TestRuntime, model: string, aliasOf: string): void {
  runtime.runSync(Effect.flatMap(LedgerConfig, config => config.setModelAlias(model, aliasOf)))
}

function setPriceOverride(
  runtime: TestRuntime,
  model: string,
  override: { inputPricePerMillion: number; outputPricePerMillion: number },
): void {
  runtime.runSync(Effect.flatMap(LedgerConfig, config => config.setPriceOverride(model, override)))
}

function modelsView(runtime: TestRuntime, scope: OverviewScope = { period: 'lifetime' }): ModelsPayload {
  return runtime.runSync(atTime(queryModelsView(viewInputs(scope)), NOW))
}

function compareView(runtime: TestRuntime, scope: OverviewScope = { period: 'lifetime' }): ComparePayload {
  return runtime.runSync(atTime(queryCompareView(viewInputs(scope)), NOW))
}

function sessionsView(runtime: TestRuntime, scope: OverviewScope = { period: 'lifetime' }): SessionRow[] {
  return runtime.runSync(atTime(querySessionsView(viewInputs(scope)), NOW))
}

function spendView(runtime: TestRuntime, scope: OverviewScope = { period: 'lifetime' }): SpendPayload {
  return runtime.runSync(atTime(querySpendView(viewInputs(scope)), NOW))
}

type Spec = {
  sessionId: string
  provider: string
  model: string
  cost: number
  date: string
  input?: number
  output?: number
  skills?: string[]
  tools?: string[]
}

function cachedFile(spec: Spec): CachedFile {
  const iso = new Date(`${spec.date}T12:00:00`).toISOString()
  const base = buildFixtureCachedCall(0)
  const call = {
    ...base,
    provider: spec.provider,
    model: spec.model,
    usage: {
      ...base.usage,
      inputTokens: spec.input ?? 1000,
      outputTokens: spec.output ?? 500,
      reasoningTokens: 0,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
      cachedInputTokens: 0,
      webSearchRequests: 0,
    },
    costUSD: spec.cost,
    timestamp: iso,
    skills: spec.skills ?? [],
    tools: spec.tools ?? base.tools,
  }
  const turn = buildFixtureCachedTurn(0, `task ${spec.sessionId}`, {
    sessionId: spec.sessionId,
    timestamp: iso,
    calls: [call],
  })
  return buildFixtureCachedFile({ canonicalProjectName: 'demo-project', title: '', turns: [turn] })
}

function port(runtime: TestRuntime, specs: Spec[]): void {
  runtime.runSync(
    Effect.flatMap(LedgerIngest, ingest =>
      Effect.forEach(specs, (spec, i) =>
        ingest.portIn({
          provider: spec.provider,
          envFingerprint: 'env-demo',
          filePath: `/cache/${spec.provider}/${spec.sessionId}-${i}.jsonl`,
          verdict: 'new',
          cachedFile: cachedFile(spec),
        }),
      ),
    ),
  )
}

describe('custom pricing applies query-time in every Section (issue 77)', () => {
  it('an Alias from a Models unpriced row reprices every Section with no rescan', () => {
    const { runtime } = openLedgerFixture()
    port(runtime, [{ sessionId: 'sess-a', provider: 'claude', model: 'weird-model', cost: 0, date: '2026-07-10' }])
    setModelAlias(runtime, 'weird-model', 'claude-sonnet-4-6')

    const sessionSummaries = summariesFor(runtime)
    expect(sessionSummaries[0]!.totalCostUSD).toBeCloseTo(0.0105, 4)

    const overview = overviewView(runtime, { period: 'lifetime' })
    expect(overview.kpis.cost).toBeCloseTo(0.0105, 4)

    const sessions = sessionsView(runtime)
    expect(sessions[0]!.cost).toBeCloseTo(0.0105, 4)

    const spend = spendView(runtime, { period: 'lifetime', range: { since: '2026-07-10', until: '2026-07-10' } })
    expect(spend.byModel[0]!.cost).toBeCloseTo(0.0105, 4)

    const models = modelsView(runtime)
    expect(models.byModel[0]!.model).toBe('claude-sonnet-4-6')
    expect(models.byModel[0]!.costUSD).toBeCloseTo(0.0105, 4)
    // Audit keeps raw identity with token-source detail.
    expect(models.audit[0]!.model).toBe('weird-model')
    expect(models.audit[0]!.attributedCostUSD).toBeCloseTo(0.0105, 4)
  })

  it('a Price override reprices everywhere and wins over the Alias on the effective model', () => {
    const { runtime } = openLedgerFixture()
    port(runtime, [{ sessionId: 'sess-a', provider: 'claude', model: 'weird-model', cost: 0, date: '2026-07-10' }])
    setModelAlias(runtime, 'weird-model', 'claude-sonnet-4-6')
    setPriceOverride(runtime, 'claude-sonnet-4-6', { inputPricePerMillion: 3, outputPricePerMillion: 15 })

    // 1000 in @ $3/M + 500 out @ $15/M.
    const expected = 0.003 + 0.0075
    const sessionSummaries = summariesFor(runtime)
    expect(sessionSummaries[0]!.totalCostUSD).toBeCloseTo(expected, 9)

    const overview = overviewView(runtime, { period: 'lifetime' })
    expect(overview.kpis.cost).toBeCloseTo(expected, 9)

    const models = modelsView(runtime)
    expect(models.byModel[0]!.costUSD).toBeCloseTo(expected, 9)
  })

  it('Compare keeps raw row identity while its cost column is repriced', () => {
    const { runtime } = openLedgerFixture()
    port(runtime, [
      { sessionId: 'sess-a', provider: 'claude', model: 'weird-model', cost: 0, date: '2026-07-10' },
      { sessionId: 'sess-b', provider: 'claude', model: 'claude-opus-4', cost: 1, date: '2026-07-10' },
    ])
    setModelAlias(runtime, 'weird-model', 'claude-sonnet-4-6')

    const payload = compareView(runtime)
    const ids = payload.models.map(m => m.model)
    expect(ids).toContain('weird-model')
    expect(ids).not.toContain('claude-sonnet-4-6')
    const weird = payload.models.find(m => m.model === 'weird-model')!
    expect(weird.costUSD).toBeCloseTo(0.0105, 4)
    expect(weird.costUSD).toBeGreaterThan(0)

    // A Price override on the effective model wins in Compare too, while raw
    // row identity is preserved: 1000 in @ $6/M + 500 out @ $30/M.
    setPriceOverride(runtime, 'claude-sonnet-4-6', { inputPricePerMillion: 6, outputPricePerMillion: 30 })
    const repriced = compareView(runtime)
    const weirdRepriced = repriced.models.find(m => m.model === 'weird-model')!
    expect(weirdRepriced.costUSD).toBeCloseTo(0.021, 9)
  })

  it('changing the Alias target reprices every Section to the new target', () => {
    const { runtime } = openLedgerFixture()
    port(runtime, [{ sessionId: 'sess-a', provider: 'claude', model: 'weird-model', cost: 0, date: '2026-07-10' }])
    setModelAlias(runtime, 'weird-model', 'claude-sonnet-4-6')
    const first = summariesFor(runtime)[0]!
    expect(first.turns[0]!.assistantCalls[0]!.model).toBe('claude-sonnet-4-6')

    setModelAlias(runtime, 'weird-model', 'claude-opus-4')
    const sessionSummaries = summariesFor(runtime)
    expect(sessionSummaries[0]!.turns[0]!.assistantCalls[0]!.model).toBe('claude-opus-4')
    expect(sessionSummaries[0]!.turns[0]!.assistantCalls[0]!.rawModel).toBe('weird-model')
    const key = Object.keys(sessionSummaries[0]!.modelBreakdown)[0]!
    expect(sessionSummaries[0]!.modelBreakdown[key]!.sourceModels).toEqual(['weird-model'])

    const overview = overviewView(runtime, { period: 'lifetime' })
    expect(overview.kpis.cost).toBeCloseTo(sessionSummaries[0]!.totalCostUSD, 9)

    const models = modelsView(runtime)
    expect(models.byModel[0]!.model).toBe('claude-opus-4')
    expect(models.byModel[0]!.sourceModels).toEqual(['weird-model'])
    expect(models.audit[0]!.model).toBe('weird-model')
    expect(models.audit[0]!.aliasOf).toBe('claude-opus-4')
  })

  it('merged rows carry provenance; totals reconcile across Sections for the same Scope', () => {
    const { runtime } = openLedgerFixture()
    port(runtime, [
      { sessionId: 'sess-a', provider: 'claude', model: 'weird-model', cost: 0, date: '2026-07-10' },
      { sessionId: 'sess-b', provider: 'claude', model: 'claude-sonnet-4-6', cost: 0.0105, date: '2026-07-10' },
    ])
    setModelAlias(runtime, 'weird-model', 'claude-sonnet-4-6')

    const sessionSummaries = summariesFor(runtime)
    const total = sessionSummaries.reduce((s, x) => s + x.totalCostUSD, 0)

    const overview = overviewView(runtime, { period: 'lifetime' })
    expect(overview.kpis.cost).toBeCloseTo(total, 9)

    const sessions = sessionsView(runtime)
    expect(sessions.reduce((s, r) => s + r.cost, 0)).toBeCloseTo(total, 9)

    // Provenance: the merged breakdown names its raw feeders.
    const merged = sessionSummaries.find(s => s.sessionId === 'sess-a')!
    const key = Object.keys(merged.modelBreakdown)[0]!
    expect(merged.modelBreakdown[key]!.sourceModels).toEqual(['weird-model'])
  })

  it('the active Scope still applies exactly under custom pricing', () => {
    const { runtime } = openLedgerFixture()
    port(runtime, [
      { sessionId: 'sess-a', provider: 'claude', model: 'weird-model', cost: 0, date: '2026-07-10' },
      { sessionId: 'sess-b', provider: 'opencode', model: 'weird-model', cost: 0, date: '2026-07-10' },
    ])
    setModelAlias(runtime, 'weird-model', 'claude-sonnet-4-6')

    const claude = summariesFor(runtime, { range: FULL_RANGE, provider: 'claude' })
    const all = summariesFor(runtime)
    expect(claude).toHaveLength(1)
    expect(all).toHaveLength(2)
    expect(claude[0]!.totalCostUSD).toBeCloseTo(0.0105, 4)
  })

  it('exported data carries the same custom pricing the UI shows', () => {
    const { runtime } = openLedgerFixture()
    port(runtime, [{ sessionId: 'sess-a', provider: 'claude', model: 'weird-model', cost: 0, date: '2026-07-10' }])
    setModelAlias(runtime, 'weird-model', 'claude-sonnet-4-6')

    const projects = groupSummariesIntoProjects(summariesFor(runtime, { range: ALL_TIME_RANGE }))
    const ui = overviewView(runtime, { period: 'lifetime' })
    expect(projects.reduce((s, p) => s + p.totalCostUSD, 0)).toBeCloseTo(ui.kpis.cost, 9)
    expect(projects[0]!.sessions[0]!.totalCostUSD).toBeCloseTo(0.0105, 4)
  })

  it('the Coach ledger MCP tools answer with the same pricing the UI shows', async () => {
    const { dbPath, runtime: worker } = openLedgerFixture()
    port(worker, [{ sessionId: 'sess-a', provider: 'claude', model: 'weird-model', cost: 0, date: '2026-07-10' }])
    setModelAlias(worker, 'weird-model', 'claude-sonnet-4-6')

    const runtime = await createLedgerMcpQueryRuntime(dbPath)
    try {
      const tools = buildLedgerTools(runtime.queries)
      const ui = overviewView(worker, { period: 'lifetime' })
      const mcpOverview = (await tools.find(t => t.name === 'ledger_overview')!.run({})) as {
        kpis: { cost: number }
      }
      expect(mcpOverview.kpis.cost).toBeCloseTo(ui.kpis.cost, 9)

      const mcpSessions = (await tools.find(t => t.name === 'ledger_sessions')!.run({})) as Array<{
        cost: number
      }>
      expect(mcpSessions[0]!.cost).toBeCloseTo(ui.kpis.cost, 9)

      const mcpCalls = (await tools.find(t => t.name === 'ledger_calls')!.run({})) as Array<{
        model: string
        display_cost_usd: number
      }>
      expect(mcpCalls[0]!.model).toBe('claude-sonnet-4-6')
      expect(mcpCalls[0]!.display_cost_usd).toBeCloseTo(0.0105, 4)
    } finally {
      await runtime.dispose()
    }
  })

  it('Skills cost evidence reprices through the seam', async () => {
    const { runtime } = openLedgerFixture()
    port(runtime, [
      {
        sessionId: 'sess-a',
        provider: 'claude',
        model: 'weird-model',
        cost: 0,
        date: '2026-07-10',
        skills: ['demo-skill'],
      },
    ])
    setModelAlias(runtime, 'weird-model', 'claude-sonnet-4-6')

    const sessionSummaries = summariesFor(runtime)
    const aggs = collectSkillCandidates(sessionSummaries)
    const agg = aggs.find(a => a.name === 'demo-skill')!
    expect(agg).toBeDefined()
    // The classifier mirrors per-call skills into the turn subCategory, so one
    // call yields two skill events (turn + call) each at the display cost.
    expect(agg.costUSD).toBeCloseTo(0.021, 4)

    const payload = await skillsView(runtime)
    const draft = payload.drafts.find(d => d.name === 'demo-skill')
    expect(draft).toBeDefined()
    expect(draft!.costUSD).toBeCloseTo(0.02, 2)
  })

  it('Optimize waste figures reprice through the seam', async () => {
    const { runtime } = openLedgerFixture()
    port(runtime, [
      { sessionId: 'sess-a', provider: 'claude', model: 'weird-model', cost: 0, date: '2026-07-10', tools: ['Read'] },
    ])
    // No pricing: zero-cost session is never a low-worth candidate.
    const scope = { range: overviewDateRange({ period: 'lifetime' }, NOW) }
    expect(findLowWorthCandidates(groupSummariesIntoProjects(summariesFor(runtime, scope)))).toHaveLength(0)

    // A Price override pushing the session to $3 (1000 in @ $2000/M + 500 out
    // @ $2000/M) makes the same read-only session flaggable with the repriced cost.
    setPriceOverride(runtime, 'weird-model', { inputPricePerMillion: 2000, outputPricePerMillion: 2000 })
    const projects = groupSummariesIntoProjects(summariesFor(runtime, scope))
    const candidates = findLowWorthCandidates(projects)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.cost).toBeCloseTo(3, 9)

    const payload = await optimizeView(runtime)
    expect(payload).toBeDefined()
  })
})
