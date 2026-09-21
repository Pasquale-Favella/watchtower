import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { normalizeProjectPathKey } from '../src/main/pipeline/parser.js'
import type { CachedFile } from '../src/main/pipeline/session-cache.js'
import { buildSpendViewFromLedger } from '../src/main/spend-view.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import { formatDayLabel, providerLabel, sankeyData, stackedRows } from '../src/renderer/src/features/spend/lib.js'
import { isOtherNode, seriesColorForModel, seriesKeyForModel } from '../src/renderer/src/shared/lib/modelSeries.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'

const NOW = new Date(2026, 6, 15)

// ── Ledger-backed Spend view (map 03) ──────────────────────────────────────
// Same scope semantics as the report-based builder above, but facts come from
// the aggregation seam (range + provider at the SQL read, sessions count by
// their in-range turns). Fixtures are ported through `portIn`.

function makeLedger(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'tr-sp-'))
  return new LedgerStore(join(dir, 'data.db'))
}

type SpendSessionSpec = {
  sessionId: string
  provider: string
  model: string
  project: string
  cost: number
  date: string
}

// Distinct native checkouts per project label: the canonical key (not the
// display name) is the grouping identity, so fixtures must not share one
// canonical directory across two projects.
const SPEND_ROOT = process.platform === 'win32' ? 'C:/workspace' : '/workspace'
const spendKeyFor = (project: string): string => normalizeProjectPathKey(`${SPEND_ROOT}/${project}`)

function spendCachedFile(spec: SpendSessionSpec): CachedFile {
  const ts = new Date(`${spec.date}T12:00:00`).toISOString()
  const call = {
    ...buildFixtureCachedCall(0),
    provider: spec.provider,
    model: spec.model,
    costUSD: spec.cost,
    timestamp: ts,
  }
  const turn = buildFixtureCachedTurn(0, 'task', { sessionId: spec.sessionId, timestamp: ts, calls: [call] })
  return buildFixtureCachedFile({
    canonicalProjectName: spec.project,
    canonicalCwd: `${SPEND_ROOT}/${spec.project}`,
    title: '',
    turns: [turn],
  })
}

function portSpendSessions(store: LedgerStore, specs: SpendSessionSpec[]): void {
  specs.forEach((spec, i) => {
    store.portIn({
      provider: spec.provider,
      envFingerprint: 'env-demo',
      filePath: `/cache/${spec.provider}/sess-${i}.jsonl`,
      verdict: 'new',
      cachedFile: spendCachedFile(spec),
    })
  })
}

describe('buildSpendViewFromLedger (aggregation seam scope)', () => {
  it('aggregates daily stacked spend by model and by project for a custom range', () => {
    const store = makeLedger()
    portSpendSessions(store, [
      { sessionId: 's-0', provider: 'claude', model: 'claude-opus-4', project: 'alpha', cost: 10, date: '2026-07-10' },
      { sessionId: 's-1', provider: 'claude', model: 'claude-sonnet-4', project: 'alpha', cost: 4, date: '2026-07-11' },
      { sessionId: 's-2', provider: 'claude', model: 'claude-opus-4', project: 'beta', cost: 6, date: '2026-07-10' },
    ])
    const payload = buildSpendViewFromLedger(
      store,
      {
        period: 'lifetime',
        range: { since: '2026-07-10', until: '2026-07-12' },
      },
      NOW,
    )

    expect(payload.byModel).toEqual([
      { date: '2026-07-10', cost: 16, segments: [{ name: 'Opus 4', cost: 16 }] },
      { date: '2026-07-11', cost: 4, segments: [{ name: 'Sonnet 4', cost: 4 }] },
      { date: '2026-07-12', cost: 0, segments: [] },
    ])
    expect(payload.byProject).toEqual([
      {
        date: '2026-07-10',
        cost: 16,
        segments: [
          { name: 'alpha', cost: 10 },
          { name: 'beta', cost: 6 },
        ],
      },
      { date: '2026-07-11', cost: 4, segments: [{ name: 'alpha', cost: 4 }] },
      { date: '2026-07-12', cost: 0, segments: [] },
    ])
    expect(payload.dataStart).toBe('2026-07-10')
    expect(payload.flow).toEqual({
      models: [
        { id: 'Opus 4', label: 'Opus 4', cost: 16 },
        { id: 'Sonnet 4', label: 'Sonnet 4', cost: 4 },
      ],
      projects: [
        { id: spendKeyFor('alpha'), label: 'alpha', cost: 14 },
        { id: spendKeyFor('beta'), label: 'beta', cost: 6 },
      ],
      links: [
        { model: 'Opus 4', project: spendKeyFor('alpha'), cost: 10 },
        { model: 'Opus 4', project: spendKeyFor('beta'), cost: 6 },
        { model: 'Sonnet 4', project: spendKeyFor('alpha'), cost: 4 },
      ],
    })
    store.close()
  })

  it('keeps period-scope spend flowing even when it falls outside the 15-day chart window', () => {
    const store = makeLedger()
    portSpendSessions(store, [
      { sessionId: 's-0', provider: 'claude', model: 'claude-opus-4', project: 'alpha', cost: 5, date: '2026-07-01' },
      { sessionId: 's-1', provider: 'claude', model: 'claude-sonnet-4', project: 'beta', cost: 8, date: '2026-07-10' },
    ])
    const payload = buildSpendViewFromLedger(store, { period: 'lifetime' }, new Date(2026, 6, 20))

    expect(payload.byModel).toHaveLength(15)
    expect(payload.byModel[0]?.date).toBe('2026-07-06')
    expect(payload.byModel[4]).toEqual({
      date: '2026-07-10',
      cost: 8,
      segments: [{ name: 'Sonnet 4', cost: 8 }],
    })
    expect(payload.dataStart).toBe('2026-07-10')
    expect(payload.flow.models).toEqual([
      { id: 'Sonnet 4', label: 'Sonnet 4', cost: 8 },
      { id: 'Opus 4', label: 'Opus 4', cost: 5 },
    ])
    store.close()
  })

  it('filters to a single provider at the SQL read (per-source)', () => {
    const store = makeLedger()
    portSpendSessions(store, [
      { sessionId: 's-0', provider: 'claude', model: 'claude-opus-4', project: 'alpha', cost: 10, date: '2026-07-10' },
      { sessionId: 's-1', provider: 'opencode', model: 'claude-haiku-4', project: 'beta', cost: 7, date: '2026-07-10' },
    ])
    const payload = buildSpendViewFromLedger(
      store,
      {
        period: 'lifetime',
        provider: 'claude',
        range: { since: '2026-07-10', until: '2026-07-10' },
      },
      NOW,
    )

    expect(payload.byModel[0]).toEqual({ date: '2026-07-10', cost: 10, segments: [{ name: 'Opus 4', cost: 10 }] })
    expect(payload.byProject[0]).toEqual({ date: '2026-07-10', cost: 10, segments: [{ name: 'alpha', cost: 10 }] })
    expect(payload.flow.projects).toEqual([{ id: spendKeyFor('alpha'), label: 'alpha', cost: 10 }])
    store.close()
  })

  it('rolls models beyond the top eight into an Other flow node', () => {
    const store = makeLedger()
    const specs: SpendSessionSpec[] = Array.from({ length: 10 }, (_, i) => ({
      sessionId: `s-${i}`,
      provider: 'claude',
      model: `model-${i}`,
      project: 'alpha',
      cost: 10 - i,
      date: `2026-07-${String(i + 1).padStart(2, '0')}`,
    }))
    portSpendSessions(store, specs)
    const payload = buildSpendViewFromLedger(
      store,
      {
        period: 'lifetime',
        range: { since: '2026-07-01', until: '2026-07-10' },
      },
      NOW,
    )

    expect(payload.flow.models).toHaveLength(9)
    expect(payload.flow.models.map(m => m.id)).toEqual([
      'model-0',
      'model-1',
      'model-2',
      'model-3',
      'model-4',
      'model-5',
      'model-6',
      'model-7',
      '__other__',
    ])
    expect(payload.flow.models[8]).toEqual({ id: '__other__', label: 'Other', cost: 3 })
    expect(payload.flow.projects).toEqual([{ id: spendKeyFor('alpha'), label: 'alpha', cost: 55 }])
    store.close()
  })

  it('gates whole turns on their first call timestamp at range boundaries', () => {
    // Byte lock for the streamed Sankey reads (#141 item 1): a turn whose
    // FIRST call falls before the range contributes none of its calls, even
    // the in-range ones; a turn starting in-range contributes all of its
    // calls to the flow (but only in-window calls to the daily buckets).
    const store = makeLedger()
    const early = { ...buildFixtureCachedCall(0), provider: 'claude', model: 'claude-opus-4', costUSD: 100, timestamp: '2026-07-05T12:00:00.000Z' }
    const late = { ...buildFixtureCachedCall(1), provider: 'claude', model: 'claude-opus-4', costUSD: 50, timestamp: '2026-07-11T12:00:00.000Z' }
    const straddler = buildFixtureCachedFile({
      canonicalProjectName: 'alpha',
      canonicalCwd: `${SPEND_ROOT}/alpha`,
      title: '',
      turns: [
        buildFixtureCachedTurn(0, 'task', { sessionId: 's-straddle', timestamp: '2026-07-05T12:00:00.000Z', calls: [early, late] }),
      ],
    })
    store.portIn({ provider: 'claude', envFingerprint: 'env-demo', filePath: '/cache/claude/straddle.jsonl', verdict: 'new', cachedFile: straddler })
    portSpendSessions(store, [
      { sessionId: 's-1', provider: 'claude', model: 'claude-sonnet-4', project: 'beta', cost: 7, date: '2026-07-11' },
    ])
    const payload = buildSpendViewFromLedger(
      store,
      { period: 'lifetime', range: { since: '2026-07-10', until: '2026-07-12' } },
      NOW,
    )
    // The straddling turn's in-range $50 call is excluded with its turn.
    expect(payload.byModel[1]).toEqual({ date: '2026-07-11', cost: 7, segments: [{ name: 'Sonnet 4', cost: 7 }] })
    expect(payload.flow.models).toEqual([{ id: 'Sonnet 4', label: 'Sonnet 4', cost: 7 }])
    store.close()
  })

  it('counts out-of-window calls of an in-range turn in the flow but not the daily buckets', () => {
    const store = makeLedger()
    const first = { ...buildFixtureCachedCall(0), provider: 'claude', model: 'claude-opus-4', costUSD: 30, timestamp: '2026-07-11T12:00:00.000Z' }
    const second = { ...buildFixtureCachedCall(1), provider: 'claude', model: 'claude-opus-4', costUSD: 20, timestamp: '2026-07-20T12:00:00.000Z' }
    const trailing = buildFixtureCachedFile({
      canonicalProjectName: 'alpha',
      canonicalCwd: `${SPEND_ROOT}/alpha`,
      title: '',
      turns: [
        buildFixtureCachedTurn(0, 'task', { sessionId: 's-trail', timestamp: '2026-07-11T12:00:00.000Z', calls: [first, second] }),
      ],
    })
    store.portIn({ provider: 'claude', envFingerprint: 'env-demo', filePath: '/cache/claude/trail.jsonl', verdict: 'new', cachedFile: trailing })
    const payload = buildSpendViewFromLedger(
      store,
      { period: 'lifetime', range: { since: '2026-07-10', until: '2026-07-12' } },
      NOW,
    )
    // Flow sees the whole turn ($50); the daily window only the in-window call ($30).
    expect(payload.flow.models).toEqual([{ id: 'Opus 4', label: 'Opus 4', cost: 50 }])
    expect(payload.byModel[1]).toEqual({ date: '2026-07-11', cost: 30, segments: [{ name: 'Opus 4', cost: 30 }] })
    store.close()
  })

  it('streams session chunks byte-identically at any chunk size (#141 item 1)', () => {
    const store = makeLedger()
    const specs: SpendSessionSpec[] = Array.from({ length: 10 }, (_, i) => ({
      sessionId: `s-${i}`,
      provider: 'claude',
      model: `model-${i}`,
      project: 'alpha',
      cost: 10 - i,
      date: `2026-07-${String(i + 1).padStart(2, '0')}`,
    }))
    portSpendSessions(store, specs)
    const scope = {
      period: 'lifetime',
      range: { since: '2026-07-01', until: '2026-07-10' },
    } as const
    // One session per chunk exercises every chunk boundary; chunks are
    // session-granular, so the payload must equal the default chunking.
    const chunked = buildSpendViewFromLedger(store, scope, NOW, undefined, 1)
    const whole = buildSpendViewFromLedger(store, scope, NOW)
    expect(chunked).toEqual(whole)
    store.close()
  })

  it('returns an empty payload for an empty ledger', () => {
    const store = makeLedger()
    const payload = buildSpendViewFromLedger(store, { period: 'lifetime' }, NOW)
    expect(payload.byModel).toHaveLength(15)
    expect(payload.byModel.every(day => day.cost === 0 && day.segments.length === 0)).toBe(true)
    expect(payload.dataStart).toBeNull()
    expect(payload.flow).toEqual({ models: [], projects: [], links: [] })
    store.close()
  })

  it('pages the flow top-N with flowLimit (default 8 unchanged)', () => {
    const store = makeLedger()
    const specs: SpendSessionSpec[] = Array.from({ length: 10 }, (_, i) => ({
      sessionId: `s-${i}`,
      provider: 'claude',
      model: `model-${i}`,
      project: 'alpha',
      cost: 10 - i,
      date: `2026-07-${String(i + 1).padStart(2, '0')}`,
    }))
    portSpendSessions(store, specs)
    const scope = {
      period: 'lifetime',
      range: { since: '2026-07-01', until: '2026-07-10' },
    } as const
    const paged = buildSpendViewFromLedger(store, scope, NOW, { flowLimit: 3 })
    expect(paged.flow.models.map(m => m.id)).toEqual(['model-0', 'model-1', 'model-2', '__other__'])
    // Garbage normalizes to the default instead of throwing.
    const fallback = buildSpendViewFromLedger(store, scope, NOW, { flowLimit: 'all' })
    expect(fallback.flow.models).toHaveLength(9)
    store.close()
  })
})

describe('spend lib helpers', () => {
  it('title-cases provider labels', () => {
    expect(providerLabel('all')).toBe('All models')
    expect(providerLabel('')).toBe('All models')
    expect(providerLabel('claude-code')).toBe('Claude Code')
    expect(providerLabel('opencode')).toBe('Opencode')
  })

  it('formats date-only keys at local noon', () => {
    expect(formatDayLabel('2026-07-11')).toBe('Jul 11')
    expect(formatDayLabel('bad')).toBe('—')
  })

  it('flattens days into recharts rows preserving dotted segment keys', () => {
    const days = [
      { date: '2026-07-10', cost: 16, segments: [{ name: 'Opus 4', cost: 16 }] },
      { date: '2026-07-11', cost: 4, segments: [{ name: 'Sonnet 4', cost: 4 }] },
      { date: '2026-07-12', cost: 0, segments: [{ name: 'GPT-5.2', cost: 2 }] },
      { date: '2026-07-13', cost: 0, segments: [] },
    ]
    const { rows, series } = stackedRows(days)
    // Series ordered by total cost descending.
    expect(series).toEqual(['Opus 4', 'Sonnet 4', 'GPT-5.2'])
    expect(rows[0]).toEqual({ date: '2026-07-10', 'Opus 4': 16 })
    expect(rows[2]?.['GPT-5.2']).toBe(2)
    expect(rows[3]).toEqual({ date: '2026-07-13' })
  })

  it('maps a SpendFlow into recharts-native Sankey node/link indices', () => {
    const flow = {
      models: [
        { id: 'Opus 4', label: 'Opus 4', cost: 16 },
        { id: 'Sonnet 4', label: 'Sonnet 4', cost: 4 },
      ],
      projects: [
        { id: 'alpha', label: 'alpha', cost: 14 },
        { id: 'beta', label: 'beta', cost: 6 },
      ],
      links: [
        { model: 'Opus 4', project: 'alpha', cost: 10 },
        { model: 'Opus 4', project: 'beta', cost: 6 },
        { model: 'Sonnet 4', project: 'alpha', cost: 4 },
      ],
    }
    const { nodes, links } = sankeyData(flow)
    expect(nodes).toEqual([
      { name: 'Opus 4', kind: 'model' },
      { name: 'Sonnet 4', kind: 'model' },
      { name: 'alpha', kind: 'project' },
      { name: 'beta', kind: 'project' },
    ])
    expect(links).toEqual([
      { source: 0, target: 2, value: 10 },
      { source: 0, target: 3, value: 6 },
      { source: 1, target: 2, value: 4 },
    ])
  })

  it('maps model names onto the theme series tokens', () => {
    expect(seriesKeyForModel('Opus 4')).toBe('opus')
    expect(seriesKeyForModel('Sonnet 5')).toBe('sonnet')
    expect(seriesKeyForModel('claude-haiku-4')).toBe('haiku')
    expect(seriesKeyForModel('gpt-5.2')).toBe('gpt')
    expect(seriesKeyForModel('Fable 5')).toBe('fable')
    expect(seriesKeyForModel('random')).toBe('other')
    expect(seriesColorForModel('Opus 4')).toBe('var(--color-s-opus)')
    expect(seriesColorForModel('random')).toBe('var(--color-s-other)')
    expect(isOtherNode('__other__')).toBe(true)
    expect(isOtherNode('Other')).toBe(true)
    expect(isOtherNode('Opus 4')).toBe(false)
  })
})
