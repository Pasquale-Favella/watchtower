import * as Effect from 'effect/Effect'
import { describe, expect, it } from 'vitest'

import { queryCompareView } from '../src/main/application/compare-query.js'
import type { CachedCall, CachedFile, CachedTurn } from '../src/main/pipeline/session-cache.js'
import { LedgerIngest } from '../src/main/store/ledger-ports.js'
import { compareValue } from '../src/renderer/src/features/compare/lib.js'
import type { ComparePair, ComparePayload } from '../src/shared/schemas/compare.js'
import type { OverviewScope } from '../src/shared/schemas/overview.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'
import { atTime, openLedgerFixture, viewInputs } from './fixtures/ledger-runtime.js'

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

function compareView(
  runtime: ReturnType<typeof openLedgerFixture>['runtime'],
  scope: OverviewScope = { period: 'lifetime' },
  pair?: ComparePair,
): ComparePayload {
  return runtime.runSync(atTime(queryCompareView({ ...viewInputs(scope), pair }), NOW))
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

function comparePort(runtime: ReturnType<typeof openLedgerFixture>['runtime'], specs: CompareSessionSpec[]): void {
  runtime.runSync(
    Effect.flatMap(LedgerIngest, ingest =>
      Effect.forEach(specs, (spec, i) => {
        const provider = spec.turns[0]?.provider ?? 'claude'
        return ingest.portIn({
          provider,
          envFingerprint: 'env-demo',
          filePath: `/cache/${provider}/${spec.sessionId}.jsonl`,
          verdict: 'new',
          cachedFile: compareCachedFile(i, spec),
        })
      }),
    ),
  )
}

const COMPARE_SPECS: CompareSessionSpec[] = [
  {
    sessionId: 'sess-c0',
    date: '2026-07-10',
    turns: [
      { model: 'claude-opus-4', cost: 1 },
      { model: 'claude-opus-4', cost: 2 },
    ],
  },
  {
    sessionId: 'sess-c1',
    date: '2026-07-10',
    turns: [{ model: 'claude-sonnet-4', cost: 0.5, hasAgentSpawn: true, speed: 'fast' }],
  },
]

describe('queryCompareView (aggregation seam scope)', () => {
  it('lists models by cost desc with per-model stats', () => {
    const { runtime } = openLedgerFixture()
    comparePort(runtime, COMPARE_SPECS)
    const payload = compareView(runtime)

    expect(payload.models.map(model => model.model)).toEqual(['claude-opus-4', 'claude-sonnet-4'])
    const modelA = payload.models[0]!
    expect(modelA.displayName).toBe('Opus 4')
    expect(modelA.calls).toBe(2)
    expect(modelA.costUSD).toBe(3)
    expect(modelA.inputTokens).toBe(200)
    expect(modelA.outputTokens).toBe(100)
    expect(modelA.cacheReadTokens).toBe(40)
  })

  it('defaults to the top two models and honors an explicit pair', () => {
    const { runtime } = openLedgerFixture()
    comparePort(runtime, COMPARE_SPECS)
    const defaulted = compareView(runtime)
    expect(defaulted.report!.modelA.model).toBe('claude-opus-4')
    expect(defaulted.report!.modelB.model).toBe('claude-sonnet-4')

    const swapped = compareView(runtime, { period: 'lifetime' }, { modelA: 'claude-sonnet-4', modelB: 'claude-opus-4' })
    expect(swapped.report!.modelA.model).toBe('claude-sonnet-4')
    expect(swapped.report!.modelB.model).toBe('claude-opus-4')
  })

  it('working-style card derives delegation and fast mode from the ledger calls', () => {
    const { runtime } = openLedgerFixture()
    comparePort(runtime, COMPARE_SPECS)
    const payload = compareView(runtime)
    const style = new Map(payload.report!.workingStyle.map(row => [row.label, row]))
    expect(style.get('Delegation rate')).toMatchObject({ valueA: 0, valueB: 100, formatFn: 'percent' })
    expect(style.get('Fast mode usage')).toMatchObject({ valueA: 0, valueB: 100 })
  })

  it('recomputes against the selected custom date range', () => {
    const { runtime } = openLedgerFixture()
    comparePort(runtime, COMPARE_SPECS)
    const out = compareView(runtime, {
      period: 'lifetime',
      range: { since: '2026-07-12', until: '2026-07-13' },
    })
    expect(out.models).toHaveLength(0)
    expect(out.report).toBeNull()

    const inWindow = compareView(runtime, {
      period: 'lifetime',
      range: { since: '2026-07-10', until: '2026-07-10' },
    })
    expect(inWindow.models.map(model => model.model)).toEqual(['claude-opus-4', 'claude-sonnet-4'])
  })

  it('returns an empty payload for an empty ledger', () => {
    const { runtime } = openLedgerFixture()
    const payload = compareView(runtime)
    expect(payload).toEqual({ models: [], report: null })
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
