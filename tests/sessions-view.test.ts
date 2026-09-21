import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { CachedFile } from '../src/main/pipeline/session-cache.js'
import { buildSessionsViewFromLedger } from '../src/main/sessions-view.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import type { SessionRow } from '../src/renderer/src/features/sessions/drilldown.js'
import {
  filterSessions,
  groupSessionsByProvider,
  paginateSessions,
  sortSessions,
  summarizeSessions,
  visiblePageNumbers,
} from '../src/renderer/src/features/sessions/sessions-lib.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'

// ── Ledger-backed sessions view (map 03) ───────────────────────────────────
// Same scope semantics as the report-based builder above, but the facts come
// from the aggregation seam: the range + provider filters apply at the SQL read
// (provider is per-SOURCE in the ledger) and a session counts by its in-range
// turns. Fixtures are ported through `portIn`, exactly as the delta seam (T3)
// will feed the ledger.

function makeLedger(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'tr-sv-'))
  return new LedgerStore(join(dir, 'data.db'))
}

type SessionSpec = {
  sessionId: string
  provider: string
  localDate: string
  cost: number
  turns?: number
  title?: string
}

function cachedFileFor(spec: SessionSpec): CachedFile {
  const turnCount = spec.turns ?? 1
  // Local noon so the fixture's local date is exactly `localDate`, TZ-safe.
  const ts = new Date(`${spec.localDate}T12:00:00`).toISOString()
  const perCall = spec.cost / turnCount
  const turns = Array.from({ length: turnCount }, (_, i) => {
    const call = {
      ...buildFixtureCachedCall(i),
      provider: spec.provider,
      model: `model-${i}`,
      costUSD: perCall,
      timestamp: ts,
    }
    return buildFixtureCachedTurn(i, `task ${i}`, { sessionId: spec.sessionId, timestamp: ts, calls: [call] })
  })
  return buildFixtureCachedFile({ title: spec.title ?? '', turns })
}

function portThreeSessions(store: LedgerStore): void {
  store.portIn({
    provider: 'claude',
    envFingerprint: 'env-demo',
    filePath: '/cache/claude/sess-0.jsonl',
    verdict: 'new',
    cachedFile: cachedFileFor({ sessionId: 'sess-0', provider: 'claude', localDate: '2026-07-10', cost: 10, turns: 3 }),
  })
  store.portIn({
    provider: 'opencode',
    envFingerprint: 'env-demo',
    filePath: '/cache/opencode/sess-1.jsonl',
    verdict: 'new',
    cachedFile: cachedFileFor({
      sessionId: 'sess-1',
      provider: 'opencode',
      localDate: '2026-07-20',
      cost: 5,
      turns: 5,
    }),
  })
  store.portIn({
    provider: 'claude',
    envFingerprint: 'env-demo',
    filePath: '/cache/claude/sess-2.jsonl',
    verdict: 'new',
    cachedFile: cachedFileFor({
      sessionId: 'sess-2',
      provider: 'claude',
      localDate: '2026-08-01',
      cost: 8,
      turns: 2,
      title: 'refactor API',
    }),
  })
}

describe('buildSessionsViewFromLedger (aggregation seam scope)', () => {
  it('returns every session, newest-first, for the lifetime period', () => {
    const store = makeLedger()
    portThreeSessions(store)
    const rows = buildSessionsViewFromLedger(store, { period: 'lifetime' })
    expect(rows.map(r => r.sessionId)).toEqual(['sess-2', 'sess-1', 'sess-0'])
    expect(rows.map(r => r.cost)).toEqual([8, 5, 10])
    expect(rows[0]?.turns).toBe(2)
    expect(rows[1]?.title).toBe('')
    store.close()
  })

  it('filters to a single provider at the SQL read (per-source)', () => {
    const store = makeLedger()
    portThreeSessions(store)
    const rows = buildSessionsViewFromLedger(store, { period: 'lifetime', provider: 'claude' })
    expect(rows.map(r => r.sessionId)).toEqual(['sess-2', 'sess-0'])
    store.close()
  })

  it('excludes sessions whose source is a different provider', () => {
    const store = makeLedger()
    portThreeSessions(store)
    store.portIn({
      provider: 'codex',
      envFingerprint: 'env-demo',
      filePath: '/cache/codex/sess-3.jsonl',
      verdict: 'new',
      cachedFile: cachedFileFor({ sessionId: 'sess-3', provider: 'codex', localDate: '2026-07-25', cost: 3 }),
    })
    const rows = buildSessionsViewFromLedger(store, { period: 'lifetime', provider: 'claude' })
    expect(rows.map(r => r.sessionId)).toEqual(['sess-2', 'sess-0'])
    expect(rows).toHaveLength(2)
    store.close()
  })

  it('honours an explicit custom range over the period', () => {
    const store = makeLedger()
    portThreeSessions(store)
    const rows = buildSessionsViewFromLedger(store, {
      period: 'lifetime',
      range: { since: '2026-07-15', until: '2026-07-31' },
    })
    expect(rows.map(r => r.sessionId)).toEqual(['sess-1'])
    store.close()
  })

  it('scopes the today period to the current local date', () => {
    const store = makeLedger()
    portThreeSessions(store)
    const rows = buildSessionsViewFromLedger(store, { period: 'today' }, new Date(2026, 6, 20, 9))
    expect(rows.map(r => r.sessionId)).toEqual(['sess-1'])
    store.close()
  })

  it('scopes the month period to the current local month', () => {
    const store = makeLedger()
    portThreeSessions(store)
    const rows = buildSessionsViewFromLedger(store, { period: 'month' }, new Date(2026, 6, 20, 9))
    expect(rows.map(r => r.sessionId)).toEqual(['sess-1', 'sess-0'])
    store.close()
  })

  it('returns an empty list for an empty ledger', () => {
    const store = makeLedger()
    expect(buildSessionsViewFromLedger(store, { period: 'lifetime' })).toEqual([])
    store.close()
  })

  it('pages newest-first rows with limit/offset', () => {
    const store = makeLedger()
    portThreeSessions(store)
    // Newest-first order is sess-2, sess-1, sess-0.
    expect(
      buildSessionsViewFromLedger(store, { period: 'lifetime' }, undefined, { limit: 2, offset: 0 }).map(
        r => r.sessionId,
      ),
    ).toEqual(['sess-2', 'sess-1'])
    expect(
      buildSessionsViewFromLedger(store, { period: 'lifetime' }, undefined, { limit: 2, offset: 2 }).map(
        r => r.sessionId,
      ),
    ).toEqual(['sess-0'])
    expect(buildSessionsViewFromLedger(store, { period: 'lifetime' }, undefined, { limit: 2, offset: 10 })).toEqual([])
    store.close()
  })

  it('normalizes garbage pages instead of throwing', () => {
    const store = makeLedger()
    portThreeSessions(store)
    // Negative limits clamp to one row; huge limits cap instead of exploding.
    expect(
      buildSessionsViewFromLedger(store, { period: 'lifetime' }, undefined, { limit: -5, offset: 0 }),
    ).toHaveLength(1)
    expect(
      buildSessionsViewFromLedger(store, { period: 'lifetime' }, undefined, { limit: 100_000, offset: 0 }),
    ).toHaveLength(3)
    expect(
      buildSessionsViewFromLedger(store, { period: 'lifetime' }, undefined, { limit: 'all', offset: -3 }).map(
        r => r.sessionId,
      ),
    ).toEqual(['sess-2', 'sess-1', 'sess-0'])
    store.close()
  })
})

function makeRow(partial: Partial<SessionRow>): SessionRow {
  return {
    sessionId: 's1',
    title: '',
    project: 'demo',
    provider: 'opencode',
    models: ['m1'],
    cost: 1,
    savingsUSD: 0,
    calls: 1,
    turns: 1,
    inputTokens: 100,
    outputTokens: 50,
    startedAt: '2026-07-01T09:00:00.000Z',
    endedAt: '2026-07-01T10:00:00.000Z',
    ...partial,
  }
}

const ROWS: SessionRow[] = [
  makeRow({
    sessionId: 'sess-aa',
    provider: 'claude',
    title: 'Refactor auth',
    project: 'api',
    models: ['claude-sonnet'],
    cost: 10,
    turns: 3,
    inputTokens: 1000,
    outputTokens: 500,
    endedAt: '2026-07-10T12:00:00.000Z',
  }),
  makeRow({
    sessionId: 'sess-bb',
    provider: 'opencode',
    project: 'web',
    models: ['deepseek'],
    cost: 5,
    turns: 5,
    inputTokens: 300,
    outputTokens: 100,
    endedAt: '2026-07-20T12:00:00.000Z',
  }),
  makeRow({
    sessionId: 'sess-cc',
    provider: 'claude',
    title: 'Bump deps',
    project: 'api',
    models: ['claude-sonnet'],
    cost: 8,
    turns: 2,
    inputTokens: 200,
    outputTokens: 50,
    endedAt: '2026-07-30T12:00:00.000Z',
  }),
]

describe('filterSessions (search over title/project/session-id/model)', () => {
  it('returns all rows for an empty or whitespace query', () => {
    expect(filterSessions(ROWS, '')).toEqual(ROWS)
    expect(filterSessions(ROWS, '   ')).toEqual(ROWS)
  })

  it('matches a session title, case-insensitively', () => {
    expect(filterSessions(ROWS, 'REFACTOR')).toEqual([ROWS[0]])
    expect(filterSessions(ROWS, 'bump deps')).toEqual([ROWS[2]])
  })

  it('matches a project name', () => {
    expect(filterSessions(ROWS, 'web')).toEqual([ROWS[1]])
  })

  it('matches a session id fragment', () => {
    expect(filterSessions(ROWS, 'sess-a')).toEqual([ROWS[0]])
  })

  it('matches a model name from the models list', () => {
    expect(filterSessions(ROWS, 'claude-sonnet')).toEqual([ROWS[0], ROWS[2]])
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterSessions(ROWS, 'zzz-none')).toEqual([])
  })
})

describe('sortSessions (cost / recent / turns / tokens)', () => {
  it('sorts by cost descending', () => {
    expect(sortSessions(ROWS, 'cost').map(r => r.sessionId)).toEqual(['sess-aa', 'sess-cc', 'sess-bb'])
  })

  it('sorts by turns descending', () => {
    expect(sortSessions(ROWS, 'turns').map(r => r.sessionId)).toEqual(['sess-bb', 'sess-aa', 'sess-cc'])
  })

  it('sorts by input+output tokens descending', () => {
    expect(sortSessions(ROWS, 'tokens').map(r => r.sessionId)).toEqual(['sess-aa', 'sess-bb', 'sess-cc'])
  })

  it('sorts by ended-at, most recent first', () => {
    expect(sortSessions(ROWS, 'recent').map(r => r.sessionId)).toEqual(['sess-cc', 'sess-bb', 'sess-aa'])
  })

  it('does not mutate the input rows', () => {
    const before = ROWS.map(r => r.sessionId)
    sortSessions(ROWS, 'cost')
    expect(ROWS.map(r => r.sessionId)).toEqual(before)
  })
})

describe('groupSessionsByProvider (group-by-provider toggle)', () => {
  it('groups rows under their provider with count and cost', () => {
    const groups = groupSessionsByProvider(ROWS, 'cost')
    const claude = groups.find(g => g.provider === 'claude')
    if (claude === undefined) throw new Error('test invariant violated: expected a claude group')
    const opencode = groups.find(g => g.provider === 'opencode')
    if (opencode === undefined) throw new Error('test invariant violated: expected an opencode group')
    expect(claude.count).toBe(2)
    expect(claude.cost).toBe(18)
    expect(opencode.count).toBe(1)
    expect(opencode.cost).toBe(5)
  })

  it('sorts each group by the active sort', () => {
    const groups = groupSessionsByProvider(ROWS, 'recent')
    const claude = groups.find(g => g.provider === 'claude')
    if (claude === undefined) throw new Error('test invariant violated: expected a claude group')
    expect(claude.rows.map(r => r.sessionId)).toEqual(['sess-cc', 'sess-aa'])
  })

  it('orders groups by their aggregate sort value', () => {
    const byCost = groupSessionsByProvider(ROWS, 'cost')
    expect(byCost.map(g => g.provider)).toEqual(['claude', 'opencode'])
    const byTurns = groupSessionsByProvider(ROWS, 'turns')
    expect(byTurns.map(g => g.provider)).toEqual(['claude', 'opencode'])
    const byRecent = groupSessionsByProvider(ROWS, 'recent')
    expect(byRecent.map(g => g.provider)).toEqual(['claude', 'opencode'])
  })

  it('tie-breaks equal group values by provider name', () => {
    const rows = [
      makeRow({ sessionId: 'x', provider: 'a', cost: 1, endedAt: '2026-07-01T10:00:00.000Z' }),
      makeRow({ sessionId: 'y', provider: 'b', cost: 1, endedAt: '2026-07-01T10:00:00.000Z' }),
    ]
    expect(groupSessionsByProvider(rows, 'cost').map(g => g.provider)).toEqual(['a', 'b'])
  })

  it('returns an empty list for no rows', () => {
    expect(groupSessionsByProvider([], 'cost')).toEqual([])
  })
})

describe('summarizeSessions (the summary line numbers)', () => {
  it('totals count, cost, and input+output tokens', () => {
    expect(summarizeSessions(ROWS)).toEqual({ count: 3, costUSD: 23, tokens: 2150 })
  })

  it('returns zeroed totals for no rows', () => {
    expect(summarizeSessions([])).toEqual({ count: 0, costUSD: 0, tokens: 0 })
  })
})

describe('paginateSessions (one mounted page, #139)', () => {
  const many = Array.from({ length: 250 }, (_, i) =>
    makeRow({ sessionId: `sess-${String(i).padStart(3, '0')}`, cost: 250 - i }),
  )

  it('slices the sorted rows into bounded pages', () => {
    const first = paginateSessions(many, 0, 100)
    expect(first.page).toBe(0)
    expect(first.pageCount).toBe(3)
    expect(first.pageRows).toHaveLength(100)
    expect(first.pageRows[0]?.sessionId).toBe('sess-000')
    const last = paginateSessions(many, 2, 100)
    expect(last.pageRows).toHaveLength(50)
    expect(last.pageRows[49]?.sessionId).toBe('sess-249')
  })

  it('clamps out-of-range pages to the nearest valid page', () => {
    expect(paginateSessions(many, 99, 100).page).toBe(2)
    expect(paginateSessions(many, -4, 100).page).toBe(0)
    expect(paginateSessions(ROWS, 5, 100).pageRows).toEqual(ROWS)
  })

  it('renders a single page for an empty or short list', () => {
    expect(paginateSessions([], 0, 100)).toEqual({ page: 0, pageCount: 1, pageRows: [] })
    expect(paginateSessions(ROWS, 0, 100).pageCount).toBe(1)
  })
})

describe('visiblePageNumbers (shadcn pager slots)', () => {
  it('lists every page when there are few', () => {
    expect(visiblePageNumbers(1, 0)).toEqual([0])
    expect(visiblePageNumbers(5, 2)).toEqual([0, 1, 2, 3, 4])
    expect(visiblePageNumbers(7, 6)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('collapses skipped pages into ellipsis slots around a neighbour window', () => {
    expect(visiblePageNumbers(10, 0)).toEqual([0, 1, 'ellipsis', 9])
    expect(visiblePageNumbers(10, 4)).toEqual([0, 'ellipsis', 3, 4, 5, 'ellipsis', 9])
    expect(visiblePageNumbers(10, 9)).toEqual([0, 'ellipsis', 8, 9])
  })

  it('clamps a stale current page into range', () => {
    expect(visiblePageNumbers(10, 99)).toEqual([0, 'ellipsis', 8, 9])
    expect(visiblePageNumbers(10, -3)).toEqual([0, 1, 'ellipsis', 9])
  })
})
