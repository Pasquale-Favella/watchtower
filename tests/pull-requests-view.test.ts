import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LedgerStore } from '../src/main/store/ledger.js'
import type { CachedFile } from '../src/main/pipeline/session-cache.js'
import { calculateCost } from '../src/main/pipeline/models.js'
import { buildModelsViewFromLedger } from '../src/main/models-view.js'
import { buildPullRequestsViewFromLedger } from '../src/main/pull-requests-view.js'
import { buildFixtureCachedFile, buildFixtureCachedTurn, buildFixtureCachedCall } from './fixtures/cached-file.js'
import {
  spanLabel, sessionWord, summarizePullRequests, payloadSpan,
} from '../src/renderer/src/features/pull-requests/lib.js'

const PR_A = 'https://github.com/acme/repo/pull/12'
const PR_B = 'https://github.com/acme/repo/pull/34'
const PR_C = 'https://github.com/acme/repo/pull/56'
const PR_D = 'https://github.com/acme/repo/pull/78'


// ── Ledger-backed Pull Requests view (map 03) ──────────────────────────────

type PrSessionSpec = {
  provider: string
  localDate: string
  prLinks: string[]
  turnCosts: Array<{ cost: number; prRefs?: string[] }>
  /** Stored model id for every call (defaults to the fixture's `demo-model`). */
  model?: string
}

function prMakeLedger(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'tr-pr-'))
  return new LedgerStore(join(dir, 'data.db'))
}

function prCachedFile(index: number, opts: PrSessionSpec): CachedFile {
  const noon = new Date(`${opts.localDate}T12:00:00`).toISOString()
  const turns = opts.turnCosts.map((turn, turnIndex) => {
    const base = buildFixtureCachedCall(index * 10 + turnIndex)
    const call = {
      ...base,
      provider: opts.provider,
      model: opts.model ?? base.model,
      costUSD: turn.cost,
      timestamp: noon,
    }
    return buildFixtureCachedTurn(index * 10 + turnIndex, `task ${index}-${turnIndex}`, {
      sessionId: `sess-${index}`,
      timestamp: noon,
      calls: [call],
      ...(turn.prRefs ? { prRefs: turn.prRefs } : {}),
    })
  })
  return buildFixtureCachedFile({ canonicalProjectName: 'demo', title: '', prLinks: opts.prLinks, turns })
}

function prPort(store: LedgerStore, specs: PrSessionSpec[]): void {
  specs.forEach((spec, i) => {
    store.portIn({
      provider: spec.provider,
      envFingerprint: 'env-demo',
      filePath: `/cache/${spec.provider}/sess-${i}.jsonl`,
      verdict: 'new',
      cachedFile: prCachedFile(i, spec),
    })
  })
}

const PR_SPECS: PrSessionSpec[] = [
  { provider: 'claude', localDate: '2026-07-10', prLinks: [PR_A], turnCosts: [{ cost: 10, prRefs: [PR_A] }] },
  { provider: 'opencode', localDate: '2026-07-20', prLinks: [PR_A], turnCosts: [{ cost: 5, prRefs: [PR_A] }] },
  { provider: 'claude', localDate: '2026-08-01', prLinks: [PR_B], turnCosts: [{ cost: 8, prRefs: [PR_B] }] },
  // Legacy session: prLinks but no per-turn refs -> approx row, kept as an estimate.
  { provider: 'claude', localDate: '2026-07-15', prLinks: [PR_C], turnCosts: [{ cost: 3 }] },
  // Unattributed lead-in turn plus an attributed turn.
  { provider: 'claude', localDate: '2026-07-25', prLinks: [PR_D], turnCosts: [{ cost: 2 }, { cost: 3, prRefs: [PR_D] }] },
]

describe('buildPullRequestsViewFromLedger (aggregation seam scope)', () => {
  it('aggregates turn-by-turn spend per PR and keeps legacy estimates', () => {
    const store = prMakeLedger()
    prPort(store, PR_SPECS)
    const payload = buildPullRequestsViewFromLedger(store, { period: 'lifetime' }, new Date(2026, 7, 6))

    expect(payload.rows.map(r => r.label)).toEqual(['acme/repo#12', 'acme/repo#34', 'acme/repo#56', 'acme/repo#78'])
    const prA = payload.rows.find(r => r.url === PR_A)!
    expect(prA.cost).toBe(15)
    expect(prA.sessions).toBe(2)
    expect(prA.calls).toBe(2)
    // Legacy session (prLinks but no per-turn refs) is kept as an honest
    // estimate with no category breakdown instead of being dropped.
    const prC = payload.rows.find(r => r.url === PR_C)!
    expect(prC.cost).toBe(3)
    expect(prC.categories).toBeUndefined()
    expect(payload.attributedCost).toBe(payload.rows.reduce((sum, r) => sum + r.cost, 0))
    expect(payload.attributedCost).toBe(15 + 8 + 3 + 3)
    expect(payload.unattributedCost).toBe(2)
    expect(payload.distinctCost).toBe(payload.attributedCost + payload.unattributedCost)
    store.close()
  })

  it('filters to a single provider at query time', () => {
    const store = prMakeLedger()
    prPort(store, PR_SPECS)
    const payload = buildPullRequestsViewFromLedger(store, { period: 'lifetime', provider: 'claude' }, new Date(2026, 7, 6))
    expect(payload.rows.map(r => r.url)).toEqual([PR_A, PR_B, PR_C, PR_D])
    const prA = payload.rows.find(r => r.url === PR_A)!
    expect(prA.cost).toBe(10)
    store.close()
  })

  it('honours an explicit custom range over the period', () => {
    const store = prMakeLedger()
    prPort(store, PR_SPECS)
    const payload = buildPullRequestsViewFromLedger(store, {
      period: 'lifetime',
      range: { since: '2026-07-15', until: '2026-07-31' },
    }, new Date(2026, 6, 20))
    expect(payload.rows.map(r => r.url)).toEqual([PR_A, PR_C, PR_D])
    const prA = payload.rows.find(r => r.url === PR_A)!
    expect(prA.cost).toBe(5)
    store.close()
  })

  it('scopes the today period to the current local date', () => {
    const store = prMakeLedger()
    prPort(store, PR_SPECS)
    const payload = buildPullRequestsViewFromLedger(store, { period: 'today' }, new Date(2026, 6, 20, 9))
    expect(payload.rows.map(r => r.url)).toEqual([PR_A])
    expect(payload.rows[0]!.cost).toBe(5)
    store.close()
  })

  it('returns an empty payload for an empty ledger', () => {
    const store = prMakeLedger()
    const payload = buildPullRequestsViewFromLedger(store, { period: 'lifetime' }, new Date(2026, 6, 20))
    expect(payload).toEqual({
      rows: [], distinctCost: 0, distinctSessions: 0, subagentSessions: 0, attributedCost: 0, unattributedCost: 0,
    })
    store.close()
  })

  it('an Alias reprices PR rows with no rescan and names its raw feeders', () => {
    const store = prMakeLedger()
    prPort(store, [
      { provider: 'claude', localDate: '2026-07-10', prLinks: [PR_A], turnCosts: [{ cost: 0, prRefs: [PR_A] }] },
    ])
    store.setModelAlias('demo-model', 'claude-sonnet-4-6')

    const payload = buildPullRequestsViewFromLedger(store, { period: 'lifetime' }, new Date(2026, 7, 6))
    // Fixture usage: 100 in / 50 out / 20 cache-read, repriced at the target's rates.
    const expected = calculateCost('claude-sonnet-4-6', 100, 50, 0, 20, 0, 'standard')
    expect(expected).toBeGreaterThan(0)
    expect(payload.rows).toHaveLength(1)
    expect(payload.rows[0]!.cost).toBeCloseTo(expected, 9)
    expect(payload.attributedCost).toBeCloseTo(expected, 9)
    expect(payload.distinctCost).toBeCloseTo(expected, 9)
    // Same rules as every other Section: the Models lens agrees on the money…
    const models = buildModelsViewFromLedger(store, { period: 'lifetime' }, {
      aliases: store.getModelAliases(),
      overrides: store.getPriceOverrides(),
    }, new Date(2026, 7, 6))
    expect(models.byModel[0]!.costUSD).toBeCloseTo(expected, 9)
    // …and the row carries the merge provenance instead of hiding it.
    expect(models.byModel[0]!.sourceModels).toEqual(['demo-model'])
    expect(payload.rows[0]!.modelProvenance).toEqual({
      [models.byModel[0]!.modelDisplayName]: ['demo-model'],
    })
    store.close()
  })

  it('a Price override on the effective model wins in the PR section too', () => {
    const store = prMakeLedger()
    prPort(store, [
      { provider: 'claude', localDate: '2026-07-10', prLinks: [PR_A], turnCosts: [{ cost: 0, prRefs: [PR_A] }] },
    ])
    store.setModelAlias('demo-model', 'claude-sonnet-4-6')
    store.setPriceOverride('claude-sonnet-4-6', { inputPricePerMillion: 3, outputPricePerMillion: 15 })

    // Fixture usage: 100 in @ $3/M + 50 out @ $15/M (input+output only, Models-lens rule).
    const expected = (100 / 1_000_000) * 3 + (50 / 1_000_000) * 15
    const payload = buildPullRequestsViewFromLedger(store, { period: 'lifetime' }, new Date(2026, 7, 6))
    expect(payload.rows[0]!.cost).toBeCloseTo(expected, 9)
    expect(payload.attributedCost).toBeCloseTo(expected, 9)
    store.close()
  })

  it('unaliased PR rows carry no provenance', () => {
    const store = prMakeLedger()
    prPort(store, PR_SPECS)
    const payload = buildPullRequestsViewFromLedger(store, { period: 'lifetime' }, new Date(2026, 7, 6))
    for (const row of payload.rows) expect(row.modelProvenance).toBeUndefined()
    store.close()
  })

  it('an Alias on the bare name reprices variant-spelled PR calls', () => {
    const store = prMakeLedger()
    prPort(store, [
      {
        provider: 'opencode', localDate: '2026-07-10', prLinks: [PR_A],
        turnCosts: [{ cost: 0, prRefs: [PR_A] }], model: 'Opencode/Demo-Model@20250929',
      },
    ])
    store.setModelAlias('demo-model', 'claude-sonnet-4-6')

    // Fixture usage: 100 in / 50 out / 20 cache-read, repriced at the target's rates.
    const expected = calculateCost('claude-sonnet-4-6', 100, 50, 0, 20, 0, 'standard')
    expect(expected).toBeGreaterThan(0)
    const payload = buildPullRequestsViewFromLedger(store, { period: 'lifetime' }, new Date(2026, 7, 6))
    expect(payload.rows).toHaveLength(1)
    expect(payload.rows[0]!.cost).toBeCloseTo(expected, 9)
    expect(payload.attributedCost).toBeCloseTo(expected, 9)
    const models = buildModelsViewFromLedger(store, { period: 'lifetime' }, {
      aliases: store.getModelAliases(),
      overrides: store.getPriceOverrides(),
    }, new Date(2026, 7, 6))
    expect(models.byModel[0]!.costUSD).toBeCloseTo(expected, 9)
    expect(payload.rows[0]!.modelProvenance).toEqual({
      [models.byModel[0]!.modelDisplayName]: ['Opencode/Demo-Model@20250929'],
    })
    store.close()
  })

})

describe('pullRequests lib helpers', () => {
  it('collapses a same-day PR to a single date label', () => {
    expect(spanLabel('2026-07-01T10:00:00Z', '2026-07-01T18:00:00Z')).toBe('Jul 1')
  })

  it('joins multi-day spans with a plain hyphen', () => {
    expect(spanLabel('2026-07-01T10:00:00Z', '2026-07-03T18:00:00Z')).toBe('Jul 1 - Jul 3')
  })

  it('renders a dash when both timestamps are unparseable', () => {
    expect(spanLabel('', '')).toBe('—')
  })

  it('pluralizes the session word', () => {
    expect(sessionWord(1)).toBe('session')
    expect(sessionWord(2)).toBe('sessions')
  })

  it('reconciles the attributed spend to the visible rows', () => {
    const rows = [
      { url: PR_A, label: 'acme/repo#12', cost: 15.006, sessions: 2, calls: 2, firstStarted: 'x', lastEnded: 'y', models: [] },
      { url: PR_B, label: 'acme/repo#34', cost: 8, sessions: 1, calls: 1, firstStarted: 'x', lastEnded: 'y', models: [] },
    ]
    expect(summarizePullRequests(rows).count).toBe(2)
    expect(summarizePullRequests(rows).attributedCost).toBeCloseTo(23.01, 2)
    expect(summarizePullRequests([])).toEqual({ attributedCost: 0, count: 0 })
  })

  it('spans the payload from the earliest start to the latest end', () => {
    const rows = [
      { url: PR_A, label: 'acme/repo#12', cost: 15, sessions: 2, calls: 2, firstStarted: '2026-07-10T12:00:00.000Z', lastEnded: '2026-07-11T12:00:00.000Z', models: [] },
      { url: PR_B, label: 'acme/repo#34', cost: 8, sessions: 1, calls: 1, firstStarted: '2026-07-20T12:00:00.000Z', lastEnded: '2026-07-20T18:00:00.000Z', models: [] },
    ]
    expect(payloadSpan(rows)).toBe('Jul 10 - Jul 20')
    expect(payloadSpan([rows[1]!])).toBe('Jul 20')
    expect(payloadSpan([])).toBe('—')
  })
})
