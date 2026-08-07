import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LedgerStore } from '../src/main/store/ledger.js'
import type { TokenUsage } from '../src/main/pipeline/types.js'
import type { CachedFile } from '../src/main/pipeline/session-cache.js'
import { buildModelsViewFromLedger, type ModelsConfig } from '../src/main/models-view.js'
import { buildFixtureCachedFile, buildFixtureCachedTurn, buildFixtureCachedCall } from './fixtures/cached-file.js'
import {
  categoryLabel, formatCompact, formatUsd, groupTaskRows,
  isAuditEstimated, isUnpriced, providerTitle, sumGroup,
} from '../src/renderer/src/shared/lib/models.js'

const NOW = new Date(2026, 6, 15)
const EMPTY_CONFIG: ModelsConfig = { aliases: [], overrides: [] }


// ── Ledger-backed Models view (map 04) ─────────────────────────────────────

type ModelsSessionSpec = {
  sessionId: string
  project: string
  provider: string
  model: string
  cost: number
  usage?: Partial<TokenUsage>
  date: string
  speed?: 'standard' | 'fast'
}

function modelsMakeLedger(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'tr-models-'))
  return new LedgerStore(join(dir, 'data.db'))
}

function modelsCachedFile(index: number, spec: ModelsSessionSpec): CachedFile {
  const baseCall = buildFixtureCachedCall(index)
  const iso = new Date(`${spec.date}T12:00:00`).toISOString()
  const call = {
    ...baseCall,
    provider: spec.provider,
    model: spec.model,
    usage: { ...baseCall.usage, ...spec.usage },
    costUSD: spec.cost,
    speed: spec.speed ?? 'standard',
    timestamp: iso,
  }
  const turn = buildFixtureCachedTurn(index, `task ${spec.sessionId}`, {
    sessionId: spec.sessionId,
    timestamp: iso,
    calls: [call],
  })
  return buildFixtureCachedFile({ canonicalProjectName: spec.project, title: '', turns: [turn] })
}

function modelsPort(store: LedgerStore, specs: ModelsSessionSpec[]): void {
  specs.forEach((spec, i) => {
    store.portIn({
      provider: spec.provider,
      envFingerprint: 'env-demo',
      filePath: `/cache/${spec.provider}/${spec.sessionId}.jsonl`,
      verdict: 'new',
      cachedFile: modelsCachedFile(i, spec),
    })
  })
}

const MODELS_SPECS: ModelsSessionSpec[] = [
  { sessionId: 'sess-m0', project: 'demo-project', provider: 'claude', model: 'claude-opus-4', cost: 10, date: '2026-07-10' },
  { sessionId: 'sess-m1', project: 'demo-project', provider: 'claude', model: 'claude-sonnet-4', cost: 4, date: '2026-07-11' },
  { sessionId: 'sess-m2', project: 'demo-project', provider: 'claude', model: 'claude-opus-4', cost: 6, date: '2026-07-12' },
  { sessionId: 'sess-m3', project: 'demo-project', provider: 'opencode', model: 'claude-haiku-4', cost: 7, date: '2026-07-10' },
]

describe('buildModelsViewFromLedger (aggregation seam scope)', () => {
  it('buckets by model, sorts by cost, across the full range', () => {
    const store = modelsMakeLedger()
    modelsPort(store, MODELS_SPECS)
    const payload = buildModelsViewFromLedger(store, { period: 'lifetime' }, EMPTY_CONFIG, NOW)

    expect(payload.byModel.map(row => row.model)).toEqual(['claude-opus-4', 'claude-haiku-4', 'claude-sonnet-4'])
    const opus = payload.byModel[0]!
    expect(opus.costUSD).toBe(16)
    expect(opus.calls).toBe(2)
    expect(opus.totalTokens).toBe(opus.inputTokens + opus.outputTokens + opus.cacheWriteTokens + opus.cacheReadTokens)
    store.close()
  })

  it('filters to a single provider at query time', () => {
    const store = modelsMakeLedger()
    modelsPort(store, MODELS_SPECS)
    const payload = buildModelsViewFromLedger(store, {
      period: 'lifetime',
      provider: 'claude',
      range: { since: '2026-07-10', until: '2026-07-10' },
    }, EMPTY_CONFIG, NOW)

    expect(payload.byModel.map(row => row.model)).toEqual(['claude-opus-4'])
    expect(payload.audit.map(row => row.provider)).toEqual(['claude'])
    store.close()
  })

  it('respects the custom range window', () => {
    const store = modelsMakeLedger()
    modelsPort(store, [
      { sessionId: 'sess-r0', project: 'demo-project', provider: 'claude', model: 'claude-opus-4', cost: 10, date: '2026-07-10' },
      { sessionId: 'sess-r1', project: 'demo-project', provider: 'claude', model: 'claude-sonnet-4', cost: 4, date: '2026-07-12' },
    ])
    const payload = buildModelsViewFromLedger(store, {
      period: 'lifetime',
      range: { since: '2026-07-11', until: '2026-07-13' },
    }, EMPTY_CONFIG, NOW)

    expect(payload.byModel.map(row => row.model)).toEqual(['claude-sonnet-4'])
    store.close()
  })

  it('an alias rewrites the model and reprices the row from token usage', () => {
    const store = modelsMakeLedger()
    modelsPort(store, [{
      sessionId: 'sess-mx', project: 'demo-project', provider: 'claude', model: 'weird-model', cost: 0, date: '2026-07-10',
      usage: { inputTokens: 1000, outputTokens: 500, reasoningTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, webSearchRequests: 0 },
    }])
    const payload = buildModelsViewFromLedger(store, { period: 'lifetime' }, {
      aliases: [{ model: 'weird-model', aliasOf: 'claude-sonnet-4-6' }],
      overrides: [],
    }, NOW)

    const row = payload.byModel[0]!
    expect(row.model).toBe('claude-sonnet-4-6')
    expect(row.modelDisplayName).toBe('Sonnet 4.6')
    expect(row.costUSD).toBeCloseTo(0.0105)
    const auditRow = payload.audit[0]!
    expect(auditRow.model).toBe('weird-model')
    expect(auditRow.attributedCostUSD).toBeCloseTo(0.0105)
    store.close()
  })


  it('returns an empty payload for an empty ledger', () => {
    const store = modelsMakeLedger()
    const payload = buildModelsViewFromLedger(store, { period: 'lifetime' }, EMPTY_CONFIG, NOW)
    expect(payload).toEqual({ byModel: [], byTask: [], audit: [] })
    store.close()
  })
})

describe('models lib helpers', () => {
  it('formats compact token counts', () => {
    expect(formatCompact(0)).toBe('0')
    expect(formatCompact(1842)).toBe('1.8K')
    expect(formatCompact(184000)).toBe('184K')
    expect(formatCompact(1200000)).toBe('1.2M')
    expect(formatCompact(2.5e9)).toBe('2.5B')
    expect(formatCompact(Number.NaN)).toBe('—')
  })

  it('formats USD with two decimals', () => {
    expect(formatUsd(0.42)).toBe('$0.42')
    expect(formatUsd(1234.5)).toBe('$1,234.50')
  })

  it('maps task categories to labels', () => {
    expect(categoryLabel('coding')).toBe('Coding')
    expect(categoryLabel(null)).toBe('General')
    expect(categoryLabel('build/deploy')).toBe('Build/Deploy')
    expect(categoryLabel('bogus')).toBe('bogus')
  })

  it('flags rows unpriced only when both cost and savings are zero', () => {
    expect(isUnpriced({ costUSD: 0, savingsUSD: 0 })).toBe(true)
    expect(isUnpriced({ costUSD: 0.01, savingsUSD: 0 })).toBe(false)
    expect(isUnpriced({ costUSD: 0, savingsUSD: 0.5 })).toBe(false)
  })

  it('title-cases provider names', () => {
    expect(providerTitle('opencode')).toBe('Opencode')
    expect(providerTitle('claude-code')).toBe('Claude-code')
    expect(providerTitle('')).toBe('')
  })

  it('estimates audit cost when there is no rate or the recompute diverges', () => {
    const base = {
      provider: 'claude',
      model: 'mystery-model',
      modelDisplayName: 'mystery-model',
      calls: 1,
      raw: {
        inputTokens: 1000, outputTokens: 0, reasoningTokens: 0,
        cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cachedInputTokens: 0, webSearchRequests: 0,
      },
      displayed: { inputTokens: 1000, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
      rates: {
        inputCostPerToken: 0.000003, outputCostPerToken: 0.000015,
        cacheWriteCostPerToken: 0, cacheReadCostPerToken: 0,
        webSearchCostPerRequest: 0, fastMultiplier: 1,
      },
      cost: {
        input: 0.003, output: 0, cacheWrite: 0, cacheRead: 0, webSearch: 0, recomputedTotalUSD: 0.003,
      },
    }
    expect(isAuditEstimated({ ...base, attributedCostUSD: 0.003 })).toBe(false)
    expect(isAuditEstimated({ ...base, attributedCostUSD: 0.01 })).toBe(true)
    expect(isAuditEstimated({ ...base, rates: null, attributedCostUSD: 0 })).toBe(true)
  })

  it('groups by-task rows under their model and sums the group', () => {
    const rows = [
      { provider: 'claude', model: 'claude-opus-4', modelDisplayName: 'Opus 4', category: 'coding', calls: 2, costUSD: 10, savingsUSD: 1 },
      { provider: 'claude', model: 'claude-opus-4', modelDisplayName: 'Opus 4', category: 'debugging', calls: 1, costUSD: 6, savingsUSD: 0 },
      { provider: 'claude', model: 'claude-sonnet-4', modelDisplayName: 'Sonnet 4', category: 'coding', calls: 1, costUSD: 4, savingsUSD: 0 },
    ] as unknown as ReturnType<typeof buildModelsView>['byTask']

    const groups = groupTaskRows(rows)
    expect(groups).toHaveLength(2)
    expect(groups[0]!.model).toBe('claude-opus-4')
    expect(groups[0]!.rows).toHaveLength(2)
    expect(sumGroup(groups[0]!)).toEqual({ calls: 3, costUSD: 16, savingsUSD: 1 })
    expect(groups[1]!.modelDisplayName).toBe('Sonnet 4')
  })
})
