import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCompareViewFromLedger } from '../src/main/compare-view.js'
import { buildModelsViewFromLedger } from '../src/main/models-view.js'
import { buildOptimizeViewFromLedger, findLowWorthCandidates } from '../src/main/optimize-view.js'
import { buildOverviewFromLedger } from '../src/main/overview.js'
import { buildSessionsViewFromLedger } from '../src/main/sessions-view.js'
import { buildSkillsViewFromLedger, collectSkillCandidates } from '../src/main/skills-view.js'
import { buildSpendViewFromLedger } from '../src/main/spend-view.js'
import { buildLedgerTools } from '../src/main/agents/ledger-mcp/tools.js'
import { createLedgerMcpQueryRuntime } from '../src/main/agents/ledger-mcp/query-runtime.js'
import { buildSessionSummaries, defaultRange } from '../src/main/store/aggregate.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import { buildProjectsFromLedger } from '../src/main/views.js'
import type { CachedFile } from '../src/main/pipeline/session-cache.js'
import { buildFixtureCachedFile, buildFixtureCachedTurn, buildFixtureCachedCall } from './fixtures/cached-file.js'

const NOW = new Date(2026, 6, 15)
const FULL_RANGE = defaultRange(new Date('2026-08-01T00:00:00.000Z'), 60)

function makeStore(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'tr-custom-pricing-'))
  return new LedgerStore(join(dir, 'data.db'))
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

function port(store: LedgerStore, specs: Spec[]): void {
  specs.forEach((spec, i) => {
    store.portIn({
      provider: spec.provider,
      envFingerprint: 'env-demo',
      filePath: `/cache/${spec.provider}/${spec.sessionId}-${i}.jsonl`,
      verdict: 'new',
      cachedFile: cachedFile(spec),
    })
  })
}

describe('custom pricing applies query-time in every Section (issue 77)', () => {
  it('an Alias from a Models unpriced row reprices every Section with no rescan', () => {
    const store = makeStore()
    port(store, [{ sessionId: 'sess-a', provider: 'claude', model: 'weird-model', cost: 0, date: '2026-07-10' }])
    store.setModelAlias('weird-model', 'claude-sonnet-4-6')

    const summaries = buildSessionSummaries(store, { range: FULL_RANGE })
    expect(summaries[0]!.totalCostUSD).toBeCloseTo(0.0105, 4)

    const overview = buildOverviewFromLedger(store, { period: 'lifetime' }, NOW)
    expect(overview.kpis.cost).toBeCloseTo(0.0105, 4)

    const sessions = buildSessionsViewFromLedger(store, { period: 'lifetime' }, NOW)
    expect(sessions[0]!.cost).toBeCloseTo(0.0105, 4)

    const spend = buildSpendViewFromLedger(
      store,
      { period: 'lifetime', range: { since: '2026-07-10', until: '2026-07-10' } },
      NOW,
    )
    expect(spend.byModel[0]!.cost).toBeCloseTo(0.0105, 4)

    const models = buildModelsViewFromLedger(
      store,
      { period: 'lifetime' },
      {
        aliases: store.getModelAliases(),
        overrides: store.getPriceOverrides(),
      },
      NOW,
    )
    expect(models.byModel[0]!.model).toBe('claude-sonnet-4-6')
    expect(models.byModel[0]!.costUSD).toBeCloseTo(0.0105, 4)
    // Audit keeps raw identity with token-source detail.
    expect(models.audit[0]!.model).toBe('weird-model')
    expect(models.audit[0]!.attributedCostUSD).toBeCloseTo(0.0105, 4)

    store.close()
  })

  it('a Price override reprices everywhere and wins over the Alias on the effective model', () => {
    const store = makeStore()
    port(store, [{ sessionId: 'sess-a', provider: 'claude', model: 'weird-model', cost: 0, date: '2026-07-10' }])
    store.setModelAlias('weird-model', 'claude-sonnet-4-6')
    store.setPriceOverride('claude-sonnet-4-6', { inputPricePerMillion: 3, outputPricePerMillion: 15 })

    // 1000 in @ $3/M + 500 out @ $15/M.
    const expected = 0.003 + 0.0075
    const summaries = buildSessionSummaries(store, { range: FULL_RANGE })
    expect(summaries[0]!.totalCostUSD).toBeCloseTo(expected, 9)

    const overview = buildOverviewFromLedger(store, { period: 'lifetime' }, NOW)
    expect(overview.kpis.cost).toBeCloseTo(expected, 9)

    const models = buildModelsViewFromLedger(
      store,
      { period: 'lifetime' },
      {
        aliases: store.getModelAliases(),
        overrides: store.getPriceOverrides(),
      },
      NOW,
    )
    expect(models.byModel[0]!.costUSD).toBeCloseTo(expected, 9)

    store.close()
  })

  it('Compare keeps raw row identity while its cost column is repriced', () => {
    const store = makeStore()
    port(store, [
      { sessionId: 'sess-a', provider: 'claude', model: 'weird-model', cost: 0, date: '2026-07-10' },
      { sessionId: 'sess-b', provider: 'claude', model: 'claude-opus-4', cost: 1, date: '2026-07-10' },
    ])
    store.setModelAlias('weird-model', 'claude-sonnet-4-6')

    const payload = buildCompareViewFromLedger(store, { period: 'lifetime' }, undefined, NOW)
    const ids = payload.models.map(m => m.model)
    expect(ids).toContain('weird-model')
    expect(ids).not.toContain('claude-sonnet-4-6')
    const weird = payload.models.find(m => m.model === 'weird-model')!
    expect(weird.costUSD).toBeCloseTo(0.0105, 4)
    expect(weird.costUSD).toBeGreaterThan(0)

    // A Price override on the effective model wins in Compare too, while raw
    // row identity is preserved: 1000 in @ $6/M + 500 out @ $30/M.
    store.setPriceOverride('claude-sonnet-4-6', { inputPricePerMillion: 6, outputPricePerMillion: 30 })
    const repriced = buildCompareViewFromLedger(store, { period: 'lifetime' }, undefined, NOW)
    const weirdRepriced = repriced.models.find(m => m.model === 'weird-model')!
    expect(weirdRepriced.costUSD).toBeCloseTo(0.021, 9)

    store.close()
  })

  it('changing the Alias target reprices every Section to the new target', () => {
    const store = makeStore()
    port(store, [{ sessionId: 'sess-a', provider: 'claude', model: 'weird-model', cost: 0, date: '2026-07-10' }])
    store.setModelAlias('weird-model', 'claude-sonnet-4-6')
    const first = buildSessionSummaries(store, { range: FULL_RANGE })[0]!
    expect(first.turns[0]!.assistantCalls[0]!.model).toBe('claude-sonnet-4-6')

    store.setModelAlias('weird-model', 'claude-opus-4')
    const summaries = buildSessionSummaries(store, { range: FULL_RANGE })
    expect(summaries[0]!.turns[0]!.assistantCalls[0]!.model).toBe('claude-opus-4')
    expect(summaries[0]!.turns[0]!.assistantCalls[0]!.rawModel).toBe('weird-model')
    const key = Object.keys(summaries[0]!.modelBreakdown)[0]!
    expect(summaries[0]!.modelBreakdown[key]!.sourceModels).toEqual(['weird-model'])

    const overview = buildOverviewFromLedger(store, { period: 'lifetime' }, NOW)
    expect(overview.kpis.cost).toBeCloseTo(summaries[0]!.totalCostUSD, 9)

    const models = buildModelsViewFromLedger(
      store,
      { period: 'lifetime' },
      {
        aliases: store.getModelAliases(),
        overrides: store.getPriceOverrides(),
      },
      NOW,
    )
    expect(models.byModel[0]!.model).toBe('claude-opus-4')
    expect(models.byModel[0]!.sourceModels).toEqual(['weird-model'])
    expect(models.audit[0]!.model).toBe('weird-model')
    expect(models.audit[0]!.aliasOf).toBe('claude-opus-4')

    store.close()
  })

  it('merged rows carry provenance; totals reconcile across Sections for the same Scope', () => {
    const store = makeStore()
    port(store, [
      { sessionId: 'sess-a', provider: 'claude', model: 'weird-model', cost: 0, date: '2026-07-10' },
      { sessionId: 'sess-b', provider: 'claude', model: 'claude-sonnet-4-6', cost: 0.0105, date: '2026-07-10' },
    ])
    store.setModelAlias('weird-model', 'claude-sonnet-4-6')

    const summaries = buildSessionSummaries(store, { range: FULL_RANGE })
    const total = summaries.reduce((s, x) => s + x.totalCostUSD, 0)

    const overview = buildOverviewFromLedger(store, { period: 'lifetime' }, NOW)
    expect(overview.kpis.cost).toBeCloseTo(total, 9)

    const sessions = buildSessionsViewFromLedger(store, { period: 'lifetime' }, NOW)
    expect(sessions.reduce((s, r) => s + r.cost, 0)).toBeCloseTo(total, 9)

    // Provenance: the merged breakdown names its raw feeders.
    const merged = summaries.find(s => s.sessionId === 'sess-a')!
    const key = Object.keys(merged.modelBreakdown)[0]!
    expect(merged.modelBreakdown[key]!.sourceModels).toEqual(['weird-model'])

    store.close()
  })

  it('the active Scope still applies exactly under custom pricing', () => {
    const store = makeStore()
    port(store, [
      { sessionId: 'sess-a', provider: 'claude', model: 'weird-model', cost: 0, date: '2026-07-10' },
      { sessionId: 'sess-b', provider: 'opencode', model: 'weird-model', cost: 0, date: '2026-07-10' },
    ])
    store.setModelAlias('weird-model', 'claude-sonnet-4-6')

    const claude = buildSessionSummaries(store, { range: FULL_RANGE, provider: 'claude' })
    const all = buildSessionSummaries(store, { range: FULL_RANGE })
    expect(claude).toHaveLength(1)
    expect(all).toHaveLength(2)
    expect(claude[0]!.totalCostUSD).toBeCloseTo(0.0105, 4)

    store.close()
  })

  it('exported data carries the same custom pricing the UI shows', () => {
    const store = makeStore()
    port(store, [{ sessionId: 'sess-a', provider: 'claude', model: 'weird-model', cost: 0, date: '2026-07-10' }])
    store.setModelAlias('weird-model', 'claude-sonnet-4-6')

    const projects = buildProjectsFromLedger(store)
    const ui = buildOverviewFromLedger(store, { period: 'lifetime' }, NOW)
    expect(projects.reduce((s, p) => s + p.totalCostUSD, 0)).toBeCloseTo(ui.kpis.cost, 9)
    expect(projects[0]!.sessions[0]!.totalCostUSD).toBeCloseTo(0.0105, 4)

    store.close()
  })

  it('the Coach ledger MCP tools answer with the same pricing the UI shows', async () => {
    const store = makeStore()
    port(store, [{ sessionId: 'sess-a', provider: 'claude', model: 'weird-model', cost: 0, date: '2026-07-10' }])
    store.setModelAlias('weird-model', 'claude-sonnet-4-6')

    const runtime = await createLedgerMcpQueryRuntime(store.dbPath)
    try {
      const tools = buildLedgerTools(runtime.queries)
      const ui = buildOverviewFromLedger(store, { period: 'lifetime' }, NOW)
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
      store.close()
    }
  })

  it('Skills cost evidence reprices through the seam', async () => {
    const store = makeStore()
    port(store, [
      {
        sessionId: 'sess-a',
        provider: 'claude',
        model: 'weird-model',
        cost: 0,
        date: '2026-07-10',
        skills: ['demo-skill'],
      },
    ])
    store.setModelAlias('weird-model', 'claude-sonnet-4-6')

    const summaries = buildSessionSummaries(store, { range: FULL_RANGE })
    const aggs = collectSkillCandidates(summaries)
    const agg = aggs.find(a => a.name === 'demo-skill')!
    expect(agg).toBeDefined()
    // The classifier mirrors per-call skills into the turn subCategory, so one
    // call yields two skill events (turn + call) each at the display cost.
    expect(agg.costUSD).toBeCloseTo(0.021, 4)

    const payload = await buildSkillsViewFromLedger(
      store,
      { period: 'lifetime' },
      { frequency: 1, spread: 1 },
      { now: NOW },
    )
    const draft = payload.drafts.find(d => d.name === 'demo-skill')
    expect(draft).toBeDefined()
    expect(draft!.costUSD).toBeCloseTo(0.02, 2)

    store.close()
  })

  it('Optimize waste figures reprice through the seam', async () => {
    const store = makeStore()
    port(store, [
      { sessionId: 'sess-a', provider: 'claude', model: 'weird-model', cost: 0, date: '2026-07-10', tools: ['Read'] },
    ])
    // No pricing: zero-cost session is never a low-worth candidate.
    expect(findLowWorthCandidates(buildProjectsFromLedger(store))).toHaveLength(0)

    // A Price override pushing the session to $3 (1000 in @ $2000/M + 500 out
    // @ $2000/M) makes the same read-only session flaggable with the repriced cost.
    store.setPriceOverride('weird-model', { inputPricePerMillion: 2000, outputPricePerMillion: 2000 })
    const projects = buildProjectsFromLedger(store)
    const candidates = findLowWorthCandidates(projects)
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.cost).toBeCloseTo(3, 9)

    const payload = await buildOptimizeViewFromLedger(store, { period: 'lifetime' }, { now: NOW })
    expect(payload).toBeDefined()

    store.close()
  })
})
