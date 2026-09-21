import { describe, expect, it } from 'vitest'

import {
  decodeSessionCursor,
  encodeSessionCursor,
  filterSessions,
  querySessionPage,
  type SessionQuery,
  sortSessions,
  summarizeSessions,
} from '../src/shared/lib/sessions-query.js'
import type { SessionRow } from '../src/shared/schemas/views.js'

// ── Server-side sessions query (#139 scope 3, #141 item 2) ─────────────────
// Pure, process-agnostic search/sort/slice over already-scoped SessionRows:
// the main process runs this over its SQL-bounded set and only the page +
// totals cross IPC. These tests pin the shared semantics both sides rely on.

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

  it('matches a project name, session id fragment, or model name', () => {
    expect(filterSessions(ROWS, 'web')).toEqual([ROWS[1]])
    expect(filterSessions(ROWS, 'sess-a')).toEqual([ROWS[0]])
    expect(filterSessions(ROWS, 'claude-sonnet')).toEqual([ROWS[0], ROWS[2]])
  })

  it('returns an empty list when nothing matches', () => {
    expect(filterSessions(ROWS, 'zzz-none')).toEqual([])
  })
})

describe('sortSessions (cost / recent / turns / tokens)', () => {
  it('sorts by cost, turns, tokens, and recency, descending', () => {
    expect(sortSessions(ROWS, 'cost').map(r => r.sessionId)).toEqual(['sess-aa', 'sess-cc', 'sess-bb'])
    expect(sortSessions(ROWS, 'turns').map(r => r.sessionId)).toEqual(['sess-bb', 'sess-aa', 'sess-cc'])
    expect(sortSessions(ROWS, 'tokens').map(r => r.sessionId)).toEqual(['sess-aa', 'sess-bb', 'sess-cc'])
    expect(sortSessions(ROWS, 'recent').map(r => r.sessionId)).toEqual(['sess-cc', 'sess-bb', 'sess-aa'])
  })

  it('breaks sort-value ties by session id (total order for keyset cursors)', () => {
    const tied = [
      makeRow({ sessionId: 'sess-b', cost: 5 }),
      makeRow({ sessionId: 'sess-a', cost: 5 }),
      makeRow({ sessionId: 'sess-c', cost: 9 }),
    ]
    expect(sortSessions(tied, 'cost').map(r => r.sessionId)).toEqual(['sess-c', 'sess-a', 'sess-b'])
  })

  it('does not mutate the input rows', () => {
    const before = ROWS.map(r => r.sessionId)
    sortSessions(ROWS, 'cost')
    expect(ROWS.map(r => r.sessionId)).toEqual(before)
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

describe('querySessionPage (server-side search/sort/slice)', () => {
  const many = Array.from({ length: 250 }, (_, i) =>
    makeRow({ sessionId: `sess-${String(i).padStart(3, '0')}`, cost: 250 - i }),
  )

  it('returns the first page with totals and a continuation cursor by default', () => {
    const page = querySessionPage(many, {})
    expect(page.rows).toHaveLength(100)
    expect(page.rows[0]?.sessionId).toBe('sess-000')
    expect(page.total).toBe(250)
    expect(page.summary).toEqual({ count: 250, costUSD: 31375, tokens: 250 * 150 })
    expect(page.start).toBe(0)
    expect(typeof page.nextCursor).toBe('string')
  })

  it('slices by limit/offset and reports the applied start', () => {
    const page = querySessionPage(many, { limit: 100, offset: 200 })
    expect(page.rows).toHaveLength(50)
    expect(page.rows[0]?.sessionId).toBe('sess-200')
    expect(page.start).toBe(200)
    expect(page.nextCursor).toBeNull()
  })

  it('clamps an out-of-range offset to a full last page instead of an empty one', () => {
    const page = querySessionPage(many, { limit: 100, offset: 999 })
    expect(page.rows).toHaveLength(100)
    expect(page.rows[0]?.sessionId).toBe('sess-150')
    expect(page.start).toBe(150)
    expect(page.nextCursor).toBeNull()
  })

  it('searches and sorts before slicing', () => {
    const page = querySessionPage(ROWS, { query: 'claude-sonnet', sort: 'recent' })
    expect(page.total).toBe(2)
    expect(page.rows.map(r => r.sessionId)).toEqual(['sess-cc', 'sess-aa'])
    expect(page.summary).toEqual({ count: 2, costUSD: 18, tokens: 1500 + 250 })
    expect(page.nextCursor).toBeNull()
  })

  it('walks pages with keyset cursors, stably and without overlap', () => {
    const first = querySessionPage(many, { limit: 100 })
    if (first.nextCursor === null) throw new Error('test invariant violated: expected a continuation cursor')
    const second = querySessionPage(many, { limit: 100, cursor: first.nextCursor })
    expect(second.rows).toHaveLength(100)
    expect(second.rows[0]?.sessionId).toBe('sess-100')
    expect(second.start).toBe(100)
    // No overlap, no gap across the cursor boundary.
    expect(first.rows.map(r => r.sessionId)).not.toContain('sess-100')
    if (second.nextCursor === null) throw new Error('test invariant violated: expected a continuation cursor')
    const third = querySessionPage(many, { limit: 100, cursor: second.nextCursor })
    expect(third.rows).toHaveLength(50)
    expect(third.rows[49]?.sessionId).toBe('sess-249')
    expect(third.nextCursor).toBeNull()
  })

  it('ignores a cursor whose sort does not match the request sort', () => {
    const first = querySessionPage(many, { limit: 100, sort: 'cost' })
    if (first.nextCursor === null) throw new Error('test invariant violated: expected a continuation cursor')
    const page = querySessionPage(many, { limit: 100, sort: 'recent', offset: 200, cursor: first.nextCursor })
    expect(page.start).toBe(200)
  })

  it('normalizes garbage instead of throwing', () => {
    const query: SessionQuery = { limit: 'all', offset: -3, sort: 'bogus', cursor: '!!!not-a-cursor!!!' }
    const page = querySessionPage(many, query)
    expect(page.rows).toHaveLength(100)
    expect(page.start).toBe(0)
    expect(page.total).toBe(250)
  })
})

describe('session cursor codec', () => {
  it('round-trips an opaque cursor string', () => {
    const encoded = encodeSessionCursor({ sort: 'cost', value: 12.5, sessionId: 'sess-9' })
    expect(typeof encoded).toBe('string')
    expect(decodeSessionCursor(encoded)).toEqual({ sort: 'cost', value: 12.5, sessionId: 'sess-9' })
  })

  it('rejects malformed or misshapen cursors as null', () => {
    expect(decodeSessionCursor('!!!not-a-cursor!!!')).toBeNull()
    expect(decodeSessionCursor('')).toBeNull()
    expect(decodeSessionCursor(42)).toBeNull()
  })
})
