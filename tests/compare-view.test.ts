import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LedgerStore } from '../src/main/store/ledger.js'
import type { CachedCall, CachedFile, CachedTurn } from '../src/main/pipeline/session-cache.js'
import { buildCompareViewFromLedger, type ComparePair } from '../src/main/compare-view.js'
import { buildFixtureCachedFile, buildFixtureCachedTurn, buildFixtureCachedCall } from './fixtures/cached-file.js'
import { compareValue } from '../src/renderer/src/features/compare/lib.js'

const NOW = new Date(2026, 6, 15)



// ── Ledger-backed Compare view (map 05) ────────────────────────────────────

type CompareSessionSpec = {
  sessionId: string
  date: string
  turns: Array<{
    model: string
    provider?: string
    cost: number
    tools?: string[]
    hasAgentSpawn?: boolean
    hasPlanMode?: boolean
    speed?: 'standard' | 'fast'
  }>
}

function compareMakeLedger(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'tr-cmp-'))
  return new LedgerStore(join(dir, 'data.db'))
}

function compareCachedFile(index: number, spec: CompareSessionSpec): CachedFile {
  const iso = new Date(`${spec.date}T12:00:00`).toISOString()
  const turns: CachedTurn[] = spec.turns.map((turn, turnIndex) => {
    const tools = new Set(turn.tools ?? ['Edit'])
    if (turn.hasAgentSpawn) tools.add('Agent')
    if (turn.hasPlanMode) tools.add('EnterPlanMode')
    const call: CachedCall = {
      ...buildFixtureCachedCall(index * 10 + turnIndex),
      provider: turn.provider ?? 'claude',
      model: turn.model,
      costUSD: turn.cost,
      tools: [...tools],
      speed: turn.speed ?? 'standard',
      timestamp: iso,
    }
    return buildFixtureCachedTurn(index * 10 + turnIndex, `prompt ${index}-${turnIndex}`, {
      sessionId: spec.sessionId,
      timestamp: iso,
      calls: [call],
    })
  })
  return buildFixtureCachedFile({ canonicalProjectName: 'demo-project', title: '', turns })
}

function comparePort(store: LedgerStore, specs: CompareSessionSpec[]): void {
  specs.forEach((spec, i) => {
    const provider = spec.turns[0]?.provider ?? 'claude'
    store.portIn({
      provider,
      envFingerprint: 'env-demo',
      filePath: `/cache/${provider}/${spec.sessionId}.jsonl`,
      verdict: 'new',
      cachedFile: compareCachedFile(i, spec),
    })
  })
}

const COMPARE_SPECS: CompareSessionSpec[] = [
  {
    sessionId: 'sess-c0', date: '2026-07-10',
    turns: [
      { model: 'claude-opus-4', cost: 1 },
      { model: 'claude-opus-4', cost: 2 },
    ],
  },
  {
    sessionId: 'sess-c1', date: '2026-07-10',
    turns: [
      { model: 'claude-sonnet-4', cost: 0.5, hasAgentSpawn: true, speed: 'fast' },
    ],
  },
]

describe('buildCompareViewFromLedger (aggregation seam scope)', () => {
  it('lists models by cost desc with per-model stats', () => {
    const store = compareMakeLedger()
    comparePort(store, COMPARE_SPECS)
    const payload = buildCompareViewFromLedger(store, { period: 'lifetime' }, undefined, NOW)

    expect(payload.models.map(model => model.model)).toEqual(['claude-opus-4', 'claude-sonnet-4'])
    const modelA = payload.models[0]!
    expect(modelA.displayName).toBe('Opus 4')
    expect(modelA.calls).toBe(2)
    expect(modelA.costUSD).toBe(3)
    expect(modelA.inputTokens).toBe(200)
    expect(modelA.outputTokens).toBe(100)
    expect(modelA.cacheReadTokens).toBe(40)
    store.close()
  })

  it('defaults to the top two models and honors an explicit pair', () => {
    const store = compareMakeLedger()
    comparePort(store, COMPARE_SPECS)
    const defaulted = buildCompareViewFromLedger(store, { period: 'lifetime' }, undefined, NOW)
    expect(defaulted.report!.modelA.model).toBe('claude-opus-4')
    expect(defaulted.report!.modelB.model).toBe('claude-sonnet-4')

    const swapped = buildCompareViewFromLedger(store, { period: 'lifetime' }, { modelA: 'claude-sonnet-4', modelB: 'claude-opus-4' }, NOW)
    expect(swapped.report!.modelA.model).toBe('claude-sonnet-4')
    expect(swapped.report!.modelB.model).toBe('claude-opus-4')
    store.close()
  })

  it('working-style card derives delegation and fast mode from the ledger calls', () => {
    const store = compareMakeLedger()
    comparePort(store, COMPARE_SPECS)
    const payload = buildCompareViewFromLedger(store, { period: 'lifetime' }, undefined, NOW)
    const style = new Map(payload.report!.workingStyle.map(row => [row.label, row]))
    expect(style.get('Delegation rate')).toMatchObject({ valueA: 0, valueB: 100, formatFn: 'percent' })
    expect(style.get('Fast mode usage')).toMatchObject({ valueA: 0, valueB: 100 })
    store.close()
  })

  it('recomputes against the selected custom date range', () => {
    const store = compareMakeLedger()
    comparePort(store, COMPARE_SPECS)
    const out = buildCompareViewFromLedger(store, {
      period: 'lifetime',
      range: { since: '2026-07-12', until: '2026-07-13' },
    }, undefined, NOW)
    expect(out.models).toHaveLength(0)
    expect(out.report).toBeNull()

    const inWindow = buildCompareViewFromLedger(store, {
      period: 'lifetime',
      range: { since: '2026-07-10', until: '2026-07-10' },
    }, undefined, NOW)
    expect(inWindow.models.map(model => model.model)).toEqual(['claude-opus-4', 'claude-sonnet-4'])
    store.close()
  })


  it('returns an empty payload for an empty ledger', () => {
    const store = compareMakeLedger()
    const payload = buildCompareViewFromLedger(store, { period: 'lifetime' }, undefined, NOW)
    expect(payload).toEqual({ models: [], report: null })
    store.close()
  })
})

describe('compare lib helpers', () => {
  it('formats each metric value by its format function', () => {
    expect(compareValue(1234, 'number')).toBe('1,234')
    expect(compareValue(3.5, 'cost')).toBe('$3.50')
    expect(compareValue(71, 'percent')).toBe('71%')
    expect(compareValue(1.234, 'decimal')).toBe('1.23')
    expect(compareValue(152600000, 'compact')).toBe('152.6M')
    expect(compareValue(null, 'percent')).toBe('—')
  })
})
