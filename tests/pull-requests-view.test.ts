import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LedgerStore } from '../src/main/store/ledger.js'
import type { CachedFile } from '../src/main/pipeline/session-cache.js'
import { buildPullRequestsViewFromLedger } from '../src/main/pull-requests-view.js'
import { buildFixtureCachedFile, buildFixtureCachedTurn, buildFixtureCachedCall } from './fixtures/cached-file.js'
import {
  spanLabel, sessionWord, summarizePullRequests,
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
}

function prMakeLedger(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'tr-pr-'))
  return new LedgerStore(join(dir, 'data.db'))
}

function prCachedFile(index: number, opts: PrSessionSpec): CachedFile {
  const noon = new Date(`${opts.localDate}T12:00:00`).toISOString()
  const turns = opts.turnCosts.map((turn, turnIndex) => {
    const call = {
      ...buildFixtureCachedCall(index * 10 + turnIndex),
      provider: opts.provider,
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
  // Legacy session: prLinks but no per-turn refs -> approx row, must be dropped.
  { provider: 'claude', localDate: '2026-07-15', prLinks: [PR_C], turnCosts: [{ cost: 3 }] },
  // Unattributed lead-in turn plus an attributed turn.
  { provider: 'claude', localDate: '2026-07-25', prLinks: [PR_D], turnCosts: [{ cost: 2 }, { cost: 3, prRefs: [PR_D] }] },
]

describe('buildPullRequestsViewFromLedger (aggregation seam scope)', () => {
  it('aggregates turn-by-turn spend per PR and drops legacy approximations', () => {
    const store = prMakeLedger()
    prPort(store, PR_SPECS)
    const payload = buildPullRequestsViewFromLedger(store, { period: 'lifetime' }, new Date(2026, 7, 6))

    expect(payload.rows.map(r => r.label)).toEqual(['acme/repo#12', 'acme/repo#34', 'acme/repo#78'])
    const prA = payload.rows.find(r => r.url === PR_A)!
    expect(prA.cost).toBe(15)
    expect(prA.sessions).toBe(2)
    expect(prA.calls).toBe(2)
    expect(payload.attributedCost).toBe(payload.rows.reduce((sum, r) => sum + r.cost, 0))
    expect(payload.attributedCost).toBe(15 + 8 + 3)
    expect(payload.unattributedCost).toBe(2)
    expect(payload.distinctCost).toBe(payload.attributedCost + payload.unattributedCost)
    store.close()
  })

  it('filters to a single provider at query time', () => {
    const store = prMakeLedger()
    prPort(store, PR_SPECS)
    const payload = buildPullRequestsViewFromLedger(store, { period: 'lifetime', provider: 'claude' }, new Date(2026, 7, 6))
    expect(payload.rows.map(r => r.url)).toEqual([PR_A, PR_B, PR_D])
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
    expect(payload.rows.map(r => r.url)).toEqual([PR_A, PR_D])
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
})
