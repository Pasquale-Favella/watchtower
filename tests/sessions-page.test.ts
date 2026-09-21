import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { CachedFile } from '../src/main/pipeline/session-cache.js'
import { buildSessionsPageFromLedger } from '../src/main/sessions-page.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'

// ── Server-side sessions paging (#139 scope 3, #141 item 2) ─────────────────
// Same scope semantics as `buildSessionsViewFromLedger`, but search, sort,
// and slicing execute in the main process over the SQL-bounded set: only one
// page plus totals is returned. Fixtures port through `portIn`.

function makeLedger(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'tr-spg-'))
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

describe('buildSessionsPageFromLedger (server-side search/sort/slice)', () => {
  it('returns the first page with filtered totals by default', () => {
    const store = makeLedger()
    portThreeSessions(store)
    const page = buildSessionsPageFromLedger(store, { period: 'lifetime' })
    expect(page.rows.map(r => r.sessionId)).toEqual(['sess-0', 'sess-2', 'sess-1'])
    expect(page.total).toBe(3)
    expect(page.summary).toEqual({ count: 3, costUSD: 23, tokens: page.summary.tokens })
    expect(page.summary.tokens).toBeGreaterThan(0)
    expect(page.start).toBe(0)
    expect(page.nextCursor).toBeNull()
    store.close()
  })

  it('searches server-side before slicing', () => {
    const store = makeLedger()
    portThreeSessions(store)
    const page = buildSessionsPageFromLedger(store, { period: 'lifetime' }, undefined, { query: 'refactor' })
    expect(page.rows.map(r => r.sessionId)).toEqual(['sess-2'])
    expect(page.total).toBe(1)
    expect(page.summary.count).toBe(1)
    store.close()
  })

  it('sorts server-side (recent first) and slices by limit/offset', () => {
    const store = makeLedger()
    portThreeSessions(store)
    // Newest-first order is sess-2, sess-1, sess-0.
    const first = buildSessionsPageFromLedger(store, { period: 'lifetime' }, undefined, {
      sort: 'recent',
      limit: 2,
      offset: 0,
    })
    expect(first.rows.map(r => r.sessionId)).toEqual(['sess-2', 'sess-1'])
    expect(first.total).toBe(3)
    if (first.nextCursor === null) throw new Error('test invariant violated: expected a continuation cursor')
    const second = buildSessionsPageFromLedger(store, { period: 'lifetime' }, undefined, {
      sort: 'recent',
      limit: 2,
      cursor: first.nextCursor,
    })
    expect(second.rows.map(r => r.sessionId)).toEqual(['sess-0'])
    expect(second.nextCursor).toBeNull()
    store.close()
  })

  it('scopes by provider and custom range like the full-list builder', () => {
    const store = makeLedger()
    portThreeSessions(store)
    const claude = buildSessionsPageFromLedger(store, { period: 'lifetime', provider: 'claude' })
    expect(claude.rows.map(r => r.sessionId)).toEqual(['sess-0', 'sess-2'])
    const july = buildSessionsPageFromLedger(
      store,
      { period: 'lifetime', range: { since: '2026-07-15', until: '2026-07-31' } },
    )
    expect(july.rows.map(r => r.sessionId)).toEqual(['sess-1'])
    store.close()
  })

  it('returns an empty page with zeroed totals for an empty ledger', () => {
    const store = makeLedger()
    const page = buildSessionsPageFromLedger(store, { period: 'lifetime' })
    expect(page).toEqual({ rows: [], total: 0, summary: { count: 0, costUSD: 0, tokens: 0 }, start: 0, nextCursor: null })
    store.close()
  })
})
