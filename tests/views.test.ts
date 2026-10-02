import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { buildOverviewFromLedger } from '../src/main/overview.js'
import type { CachedFile } from '../src/main/pipeline/session-cache.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import {
  buildAnalyticalViewsFromLedger,
  buildDashboardViewsFromLedger,
  buildProjectRowsFromLedger,
  getSessionDetailFromLedger,
  querySessionRowsFromLedger,
  searchSessionsFromLedger,
} from '../src/main/views.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'

// ── Ledger-backed views family (map 03) ─────────────────────────────────────
// The dashboard/projects/session-rows/detail/analytics/search builders consume
// the aggregation seam (all-time scope) and must be byte-identical to the
// report-based builders over the same ported facts.

function makeLedger(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'tr-views-'))
  return new LedgerStore(join(dir, 'data.db'))
}

type ViewsSessionSpec = {
  sessionId: string
  project: string
  provider: string
  model: string
  cost: number
  date: string
  title?: string
  userMessage?: string
  bashCommands?: string[]
  subagentTypes?: string[]
  prRefs?: string[]
}

function viewsCachedFile(spec: ViewsSessionSpec): CachedFile {
  const ts = new Date(`${spec.date}T09:00:00`).toISOString()
  const call = {
    ...buildFixtureCachedCall(0),
    provider: spec.provider,
    model: spec.model,
    costUSD: spec.cost,
    timestamp: ts,
    bashCommands: spec.bashCommands ?? [],
    subagentTypes: spec.subagentTypes ?? [],
  }
  const turn = buildFixtureCachedTurn(0, spec.userMessage ?? 'task', {
    sessionId: spec.sessionId,
    timestamp: ts,
    calls: [call],
    prRefs: spec.prRefs ?? [],
  })
  // Distinct native checkouts per project label: the canonical key (not the
  // display name) is the grouping identity.
  const root = process.platform === 'win32' ? 'C:/workspace' : '/workspace'
  return buildFixtureCachedFile({
    canonicalProjectName: spec.project,
    canonicalCwd: `${root}/${spec.project}`,
    title: spec.title ?? '',
    turns: [turn],
  })
}

function portViews(store: LedgerStore, specs: ViewsSessionSpec[]): void {
  specs.forEach(spec => {
    store.portIn({
      provider: spec.provider,
      envFingerprint: 'env-demo',
      filePath: `/cache/${spec.provider}/${spec.sessionId}.jsonl`,
      verdict: 'new',
      cachedFile: viewsCachedFile(spec),
    })
  })
}

const VIEWS_SPECS: ViewsSessionSpec[] = [
  {
    sessionId: 'sess-aa',
    project: 'api',
    provider: 'claude',
    model: 'claude-opus-4',
    cost: 10,
    date: '2026-07-10',
    title: 'Refactor auth',
    userMessage: 'refactor the auth module',
    bashCommands: ['npm test'],
    subagentTypes: ['explore'],
    prRefs: ['https://github.com/acme/api/pull/7'],
  },
  {
    sessionId: 'sess-bb',
    project: 'web',
    provider: 'opencode',
    model: 'deepseek-v3',
    cost: 5,
    date: '2026-07-20',
    userMessage: 'ship the widget',
    bashCommands: ['npm run deploy -- --env prod'],
  },
  {
    sessionId: 'sess-cc',
    project: 'api',
    provider: 'claude',
    model: 'claude-sonnet-4',
    cost: 8,
    date: '2026-08-01',
    userMessage: 'bump deps',
    bashCommands: ['npm run build'],
  },
]

function trackSnapshotReads(store: LedgerStore) {
  const counts: Record<string, number> = {}
  const runQueriesSync = store.runQueriesSync.bind(store)
  const runRepositorySync = store.runRepositorySync.bind(store)
  vi.spyOn(store, 'runQueriesSync').mockImplementation(operation =>
    runQueriesSync(queries =>
      operation(
        new Proxy(queries, {
          get(target, property, receiver) {
            const member = Reflect.get(target, property, receiver)
            if (typeof member !== 'function') return member
            return (...args: unknown[]) => {
              const name = String(property)
              counts[name] = (counts[name] ?? 0) + 1
              return member(...args)
            }
          },
        }),
      ),
    ),
  )
  vi.spyOn(store, 'runRepositorySync').mockImplementation(operation =>
    runRepositorySync(config =>
      operation(
        new Proxy(config, {
          get(target, property, receiver) {
            const member = Reflect.get(target, property, receiver)
            if (typeof member !== 'function') return member
            return (...args: unknown[]) => {
              const name = String(property)
              counts[name] = (counts[name] ?? 0) + 1
              return member(...args)
            }
          },
        }),
      ),
    ),
  )
  return counts
}

describe('request snapshots', () => {
  it('loads analytics provenance, facts, and pricing once for both payloads', () => {
    const store = makeLedger()
    portViews(store, VIEWS_SPECS)
    const reads = trackSnapshotReads(store)

    buildAnalyticalViewsFromLedger(store)

    expect(reads).toMatchObject({
      getSources: 1,
      getSessions: 1,
      getTurns: 1,
      getCallFacts: 1,
      getModelAliases: 1,
      getPriceOverrides: 1,
    })
    store.close()
  })

  it('reuses one snapshot for lifetime data start and the scoped overview', () => {
    const store = makeLedger()
    portViews(store, VIEWS_SPECS)
    const reads = trackSnapshotReads(store)

    buildOverviewFromLedger(
      store,
      { period: 'all', range: { since: '2026-07-01', until: '2026-08-01' } },
      new Date('2026-08-02T00:00:00.000Z'),
    )

    expect(reads).toMatchObject({
      getSources: 1,
      getSessions: 1,
      getTurns: 1,
      getCallFacts: 1,
      getModelAliases: 1,
      getPriceOverrides: 1,
    })
    store.close()
  })

  it('keeps project provenance reads constant as the source count grows', () => {
    for (const sourceCount of [2, 8]) {
      const store = makeLedger()
      portViews(
        store,
        Array.from({ length: sourceCount }, (_, index) => ({
          ...VIEWS_SPECS[0]!,
          sessionId: `session-${sourceCount}-${index}`,
        })),
      )
      expect(store.getSources()).toHaveLength(sourceCount)
      const reads = trackSnapshotReads(store)

      buildProjectRowsFromLedger(store)

      expect(reads).toMatchObject({
        getSources: 1,
        getSessions: 1,
        getTurns: 1,
        getCallFacts: 1,
        getModelAliases: 1,
        getPriceOverrides: 1,
      })
      store.close()
    }
  })
})

describe('ledger-backed views family (aggregation seam)', () => {
  it('derives dashboard KPIs and buckets from ledger rows', () => {
    const store = makeLedger()
    portViews(store, VIEWS_SPECS)

    const views = buildDashboardViewsFromLedger(store)
    expect(views.kpis).toMatchObject({
      totalCost: 23,
      totalSessions: 3,
      totalProjects: 2,
      totalCalls: 3,
      totalInputTokens: 300,
      totalOutputTokens: 150,
      totalEstimatedCost: 0,
      totalSavings: 0,
    })
    expect(views.costOverTime).toEqual([
      { date: '2026-07-10', cost: 10 },
      { date: '2026-07-20', cost: 5 },
      { date: '2026-08-01', cost: 8 },
    ])
    expect(views.byProject).toEqual([
      { name: 'api', cost: 18, calls: 2 },
      { name: 'web', cost: 5, calls: 1 },
    ])
    expect(views.byProvider).toEqual([
      { name: 'claude', cost: 18, calls: 2, sessions: 2 },
      { name: 'opencode', cost: 5, calls: 1, sessions: 1 },
    ])
    store.close()
  })

  it('returns null-safe aggregates for an empty ledger', () => {
    const store = makeLedger()
    const views = buildDashboardViewsFromLedger(store)
    expect(views.kpis.totalCost).toBe(0)
    expect(views.costOverTime).toEqual([])
    expect(views.byProvider).toEqual([])
    expect(views.byProject).toEqual([])
    expect(views.byCategory).toEqual([])
    expect(buildProjectRowsFromLedger(store)).toEqual([])
    expect(buildAnalyticalViewsFromLedger(store).subagents).toEqual([])
    expect(getSessionDetailFromLedger(store, 'nope')).toBeNull()
    expect(searchSessionsFromLedger(store, 'anything')).toEqual([])
    store.close()
  })

  it('builds project rows grouped by project with aggregated spans', () => {
    const store = makeLedger()
    portViews(store, VIEWS_SPECS)
    const rows = buildProjectRowsFromLedger(store)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ project: 'api', cost: 18, calls: 2, sessions: 2 })
    expect(rows[0].firstTimestamp.slice(0, 10)).toBe('2026-07-10')
    expect(rows[0].lastTimestamp.slice(0, 10)).toBe('2026-08-01')
    expect(rows[1]).toMatchObject({ project: 'web', cost: 5, calls: 1, sessions: 1 })
    store.close()
  })

  it('filters session rows by project and date range at query time', () => {
    const store = makeLedger()
    portViews(store, VIEWS_SPECS)
    expect(querySessionRowsFromLedger(store, {})).toHaveLength(3)
    expect(querySessionRowsFromLedger(store, { project: 'api' }).map(r => r.sessionId)).toEqual(['sess-cc', 'sess-aa'])
    const inRange = querySessionRowsFromLedger(store, { since: '2026-07-15', until: '2026-07-31' })
    expect(inRange.map(r => r.sessionId)).toEqual(['sess-bb'])
    store.close()
  })

  it('returns the full session detail and null for a missing session', () => {
    const store = makeLedger()
    portViews(store, VIEWS_SPECS)
    const detail = getSessionDetailFromLedger(store, 'sess-aa')
    expect(detail).not.toBeNull()
    expect(detail!.provider).toBe('claude')
    expect(detail!.title).toBe('Refactor auth')
    expect(detail!.totalCostUSD).toBe(10)
    expect(detail!.prLinks).toEqual(['https://github.com/acme/api/pull/7'])
    expect(detail!.turns).toHaveLength(1)
    expect(detail!.turns[0].assistantCalls[0].usage.inputTokens).toBe(100)
    expect(getSessionDetailFromLedger(store, 'does-not-exist')).toBeNull()
    store.close()
  })

  it('aggregates subagents across sessions in the analytical views', () => {
    const store = makeLedger()
    portViews(store, VIEWS_SPECS)
    const views = buildAnalyticalViewsFromLedger(store)
    expect(views.providers).toEqual([
      { name: 'claude', cost: 18, calls: 2, sessions: 2 },
      { name: 'opencode', cost: 5, calls: 1, sessions: 1 },
    ])
    expect(views.subagents).toEqual([{ name: 'explore', calls: 1, cost: 10, savingsUSD: 0 }])
    store.close()
  })

  it('finds sessions across user messages and bash commands', () => {
    const store = makeLedger()
    portViews(store, VIEWS_SPECS)
    const byMessage = searchSessionsFromLedger(store, 'refactor the auth')
    expect(byMessage).toHaveLength(1)
    expect(byMessage[0]).toMatchObject({ sessionId: 'sess-aa', kind: 'message', project: 'api' })
    const byBash = searchSessionsFromLedger(store, 'npm run deploy')
    expect(byBash).toHaveLength(1)
    expect(byBash[0]).toMatchObject({ sessionId: 'sess-bb', kind: 'bash' })
    expect(searchSessionsFromLedger(store, '')).toEqual([])
    expect(searchSessionsFromLedger(store, 'zzz-nothing')).toEqual([])
    store.close()
  })
})
