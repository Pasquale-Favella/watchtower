import { DatabaseSync, StatementSync } from 'node:sqlite'

import * as Effect from 'effect/Effect'
import { describe, expect, it, vi } from 'vitest'

import { queryOverview } from '../src/main/application/overview-query.js'
import { querySessionDetail } from '../src/main/application/session-detail-query.js'
import { querySessionSearch } from '../src/main/application/session-search-query.js'
import { queryProjectRows, querySessionRows } from '../src/main/application/store-row-queries.js'
import { queryAnalyticalViews, queryDashboardViews } from '../src/main/application/view-queries.js'
import { captureLocalModelSavings } from '../src/main/pipeline/models.js'
import { normalizeProxyPath } from '../src/main/pipeline/proxy-paths.js'
import type { CachedFile } from '../src/main/pipeline/session-cache.js'
import { LedgerIngest, LedgerQueries } from '../src/main/store/ledger-ports.js'
import { LedgerViewReads } from '../src/main/store/ledger-view-reads.js'
import type { WorkerRuntime } from '../src/main/worker-runtime.js'
import type { OverviewPayload, OverviewScope } from '../src/shared/schemas/overview.js'
import type {
  AnalyticalViews,
  DashboardViews,
  ProjectRow,
  SearchHit,
  SessionDetail,
  SessionRow,
} from '../src/shared/schemas/views.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'
import { atTime, openLedgerFixture, viewInputs } from './fixtures/ledger-runtime.js'

// ── Ledger-backed views family (map 03) ─────────────────────────────────────
// Dashboard, project/session rows, detail, analytics, overview, and search
// queries consume the same ported facts through their application boundaries.

const NOW = new Date('2026-08-02T00:00:00.000Z')

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

type SessionFilter = { project?: string; since?: string; until?: string }

function portViews(runtime: WorkerRuntime, specs: ViewsSessionSpec[]): void {
  runtime.runSync(
    Effect.flatMap(LedgerIngest, ingest =>
      Effect.forEach(specs, spec =>
        ingest.portIn({
          provider: spec.provider,
          envFingerprint: 'env-demo',
          filePath: `/cache/${spec.provider}/${spec.sessionId}.jsonl`,
          verdict: 'new',
          cachedFile: viewsCachedFile(spec),
        }),
      ),
    ),
  )
}

function viewsCachedFile(spec: ViewsSessionSpec): CachedFile {
  const timestamp = new Date(`${spec.date}T09:00:00`).toISOString()
  const call = {
    ...buildFixtureCachedCall(0),
    provider: spec.provider,
    model: spec.model,
    costUSD: spec.cost,
    timestamp,
    bashCommands: spec.bashCommands ?? [],
    subagentTypes: spec.subagentTypes ?? [],
  }
  const turn = buildFixtureCachedTurn(0, spec.userMessage ?? 'task', {
    sessionId: spec.sessionId,
    timestamp,
    calls: [call],
    prRefs: spec.prRefs ?? [],
  })
  // Distinct native checkouts per project label: the canonical key, not the
  // display name, is the grouping identity.
  const root = process.platform === 'win32' ? 'C:/workspace' : '/workspace'
  return buildFixtureCachedFile({
    canonicalProjectName: spec.project,
    canonicalCwd: `${root}/${spec.project}`,
    title: spec.title ?? '',
    turns: [turn],
  })
}

function projectRows(runtime: WorkerRuntime): ProjectRow[] {
  return runtime.runSync(queryProjectRows({ catalogue: viewInputs({ period: 'lifetime' }).catalogue }))
}

function sessionRows(runtime: WorkerRuntime, filter: SessionFilter = {}): SessionRow[] {
  return runtime.runSync(querySessionRows({ catalogue: viewInputs({ period: 'lifetime' }).catalogue, filter }))
}

function sessionDetail(runtime: WorkerRuntime, sessionId: string): SessionDetail | null {
  const { catalogue, proxyPaths } = viewInputs({ period: 'lifetime' })
  return runtime.runSync(querySessionDetail({ catalogue, proxyPaths, sessionId }))
}

function sessionSearch(runtime: WorkerRuntime, query: string): SearchHit[] {
  return runtime.runSync(querySessionSearch({ catalogue: viewInputs({ period: 'lifetime' }).catalogue, query }))
}

function dashboardViews(runtime: WorkerRuntime): DashboardViews {
  const { catalogue, proxyPaths } = viewInputs({ period: 'lifetime' })
  return runtime.runSync(queryDashboardViews({ catalogue, proxyPaths }))
}

function analyticalViews(runtime: WorkerRuntime): AnalyticalViews {
  const { catalogue, proxyPaths } = viewInputs({ period: 'lifetime' })
  return runtime.runSync(queryAnalyticalViews({ catalogue, proxyPaths }))
}

function overviewView(runtime: WorkerRuntime, scope: OverviewScope, now: Date): OverviewPayload {
  return runtime.runSync(atTime(queryOverview({ ...viewInputs(scope), localSavings: captureLocalModelSavings() }), now))
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

type NativeSelect = { readonly sql: string; readonly connection: DatabaseSync }
const SELECT_TARGET = /\bFROM\s+(?:ledger_source|ledger_session|ledger_turn|ledger_call|model_alias|price_override)\b/i

function watchNativeSelects(): NativeSelect[] {
  const executions: NativeSelect[] = []
  const sqlByStatement = new WeakMap<StatementSync, string>()
  const connectionByStatement = new WeakMap<StatementSync, DatabaseSync>()
  const nativePrepare = DatabaseSync.prototype.prepare
  const nativeAll = StatementSync.prototype.all

  vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (this: DatabaseSync, sql: string) {
    const statement = Reflect.apply(nativePrepare, this, [sql])
    sqlByStatement.set(statement, sql)
    connectionByStatement.set(statement, this)
    return statement
  })
  vi.spyOn(StatementSync.prototype, 'all').mockImplementation(function (this: StatementSync, ...parameters: unknown[]) {
    const result = Reflect.apply(nativeAll, this, parameters)
    const sql = sqlByStatement.get(this) ?? ''
    const connection = connectionByStatement.get(this)
    if (connection && /^\s*SELECT\b/i.test(sql) && SELECT_TARGET.test(sql)) executions.push({ sql, connection })
    return result
  })

  return executions
}

function expectNativeReads(executions: NativeSelect[], start: number, tables: string[]): void {
  const reads = executions.slice(start)
  const selectedTables = reads.map(({ sql }) => /\bFROM\s+([a-z_]+)/i.exec(sql)?.[1])
  expect(selectedTables).toEqual(tables)
  expect(new Set(reads.map(({ connection }) => connection)).size).toBe(1)
}

function expectRequestSnapshotReads(executions: NativeSelect[], start: number): void {
  expectNativeReads(executions, start, [
    'ledger_source',
    'ledger_session',
    'ledger_turn',
    'ledger_call',
    'model_alias',
    'price_override',
  ])
}

describe('request snapshots', () => {
  it('loads analytics projection and pricing once without a broad snapshot', () => {
    const { runtime } = openLedgerFixture()
    portViews(runtime, VIEWS_SPECS)
    const queries = runtime.runSync(LedgerQueries)
    const snapshot = vi.spyOn(queries, 'getRequestSnapshotData')
    const projection = vi.spyOn(runtime.runSync(LedgerViewReads), 'getViewData')
    const executions = watchNativeSelects()
    const readStart = executions.length

    try {
      analyticalViews(runtime)

      expect(projection).toHaveBeenCalledTimes(1)
      expect(snapshot).not.toHaveBeenCalled()
      expectNativeReads(executions, readStart, [
        'ledger_session',
        'ledger_turn',
        'ledger_call',
        'model_alias',
        'price_override',
      ])
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('reuses one snapshot for lifetime data start and the scoped overview', () => {
    const { runtime } = openLedgerFixture()
    portViews(runtime, VIEWS_SPECS)
    const queries = runtime.runSync(LedgerQueries)
    const snapshot = vi.spyOn(queries, 'getRequestSnapshotData')
    const executions = watchNativeSelects()
    const readStart = executions.length

    try {
      overviewView(runtime, { period: 'all', range: { since: '2026-07-01', until: '2026-08-01' } }, NOW)

      expect(snapshot).toHaveBeenCalledTimes(1)
      expectRequestSnapshotReads(executions, readStart)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('keeps project SELECT count constant as the source count grows', () => {
    const executions = watchNativeSelects()
    try {
      for (const sourceCount of [2, 8]) {
        const { runtime } = openLedgerFixture()
        portViews(
          runtime,
          Array.from({ length: sourceCount }, (_, index) => ({
            ...VIEWS_SPECS[0]!,
            sessionId: `session-${sourceCount}-${index}`,
          })),
        )
        const readStart = executions.length

        expect(projectRows(runtime)).toHaveLength(1)
        expectNativeReads(executions, readStart, [
          'ledger_session',
          'ledger_turn',
          'ledger_call',
          'model_alias',
          'price_override',
        ])
      }
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe('ledger-backed views family (aggregation seam)', () => {
  it('keeps project and proxy attribution independent for duplicate public session IDs', () => {
    const { runtime } = openLedgerFixture()
    const root = process.platform === 'win32' ? 'C:/workspace' : '/workspace'
    const projects = [
      { name: 'proxied', path: `${root}/proxy/proxied`, cost: 9 },
      { name: 'direct', path: `${root}/direct`, cost: 5 },
    ]
    runtime.runSync(
      Effect.flatMap(LedgerIngest, ingest =>
        Effect.forEach(projects, project =>
          ingest.portIn({
            provider: 'opencode',
            envFingerprint: 'duplicate-view-identity',
            filePath: `/cache/${project.name}.jsonl`,
            verdict: 'new',
            cachedFile: buildFixtureCachedFile({
              canonicalCwd: project.path,
              canonicalProjectName: project.name,
              turns: [
                buildFixtureCachedTurn(0, 'task', {
                  sessionId: 'same-public-session',
                  calls: [{ ...buildFixtureCachedCall(0), projectPath: project.path, costUSD: project.cost }],
                }),
              ],
            }),
          }),
        ),
      ),
    )
    const { catalogue } = viewInputs({ period: 'lifetime' })
    const result = runtime.runSync(
      queryDashboardViews({
        catalogue,
        proxyPaths: { paths: [normalizeProxyPath(`${root}/proxy`, false)], caseSensitive: false },
      }),
    )

    expect(result.kpis).toMatchObject({ totalCost: 14, totalSessions: 2, totalProjects: 2, totalProxiedCost: 9 })
    expect(result.byProject).toEqual([
      { name: 'proxied', cost: 9, calls: 1 },
      { name: 'direct', cost: 5, calls: 1 },
    ])
  })

  it('derives dashboard KPIs and buckets from ledger rows', () => {
    const { runtime } = openLedgerFixture()
    portViews(runtime, VIEWS_SPECS)

    const views = dashboardViews(runtime)
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
  })

  it('returns null-safe aggregates for an empty ledger', () => {
    const { runtime } = openLedgerFixture()
    const views = dashboardViews(runtime)
    expect(views.kpis.totalCost).toBe(0)
    expect(views.costOverTime).toEqual([])
    expect(views.byProvider).toEqual([])
    expect(views.byProject).toEqual([])
    expect(views.byCategory).toEqual([])
    expect(projectRows(runtime)).toEqual([])
    expect(analyticalViews(runtime).subagents).toEqual([])
    expect(sessionDetail(runtime, 'nope')).toBeNull()
    expect(sessionSearch(runtime, 'anything')).toEqual([])
  })

  it('builds project rows grouped by project with aggregated spans', () => {
    const { runtime } = openLedgerFixture()
    portViews(runtime, VIEWS_SPECS)
    const rows = projectRows(runtime)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ project: 'api', cost: 18, calls: 2, sessions: 2 })
    expect(rows[0].firstTimestamp.slice(0, 10)).toBe('2026-07-10')
    expect(rows[0].lastTimestamp.slice(0, 10)).toBe('2026-08-01')
    expect(rows[1]).toMatchObject({ project: 'web', cost: 5, calls: 1, sessions: 1 })
  })

  it('filters session rows by project and date range at query time', () => {
    const { runtime } = openLedgerFixture()
    portViews(runtime, VIEWS_SPECS)
    expect(sessionRows(runtime)).toHaveLength(3)
    expect(sessionRows(runtime, { project: 'api' }).map(row => row.sessionId)).toEqual(['sess-cc', 'sess-aa'])
    const inRange = sessionRows(runtime, { since: '2026-07-15', until: '2026-07-31' })
    expect(inRange.map(row => row.sessionId)).toEqual(['sess-bb'])
  })

  it('returns the full session detail and null for a missing session', () => {
    const { runtime } = openLedgerFixture()
    portViews(runtime, VIEWS_SPECS)
    const detail = sessionDetail(runtime, 'sess-aa')
    expect(detail).not.toBeNull()
    expect(detail!.provider).toBe('claude')
    expect(detail!.title).toBe('Refactor auth')
    expect(detail!.totalCostUSD).toBe(10)
    expect(detail!.prLinks).toEqual(['https://github.com/acme/api/pull/7'])
    expect(detail!.turns).toHaveLength(1)
    expect(detail!.turns[0]!.assistantCalls[0]!.usage.inputTokens).toBe(100)
    expect(sessionDetail(runtime, 'does-not-exist')).toBeNull()
  })

  it('aggregates subagents across sessions in the analytical views', () => {
    const { runtime } = openLedgerFixture()
    portViews(runtime, VIEWS_SPECS)
    const views = analyticalViews(runtime)
    expect(views.providers).toEqual([
      { name: 'claude', cost: 18, calls: 2, sessions: 2 },
      { name: 'opencode', cost: 5, calls: 1, sessions: 1 },
    ])
    expect(views.subagents).toEqual([{ name: 'explore', calls: 1, cost: 10, savingsUSD: 0 }])
  })

  it('finds sessions across user messages and bash commands', () => {
    const { runtime } = openLedgerFixture()
    portViews(runtime, VIEWS_SPECS)
    const byMessage = sessionSearch(runtime, 'refactor the auth')
    expect(byMessage).toHaveLength(1)
    expect(byMessage[0]).toMatchObject({ sessionId: 'sess-aa', kind: 'message', project: 'api' })
    const byBash = sessionSearch(runtime, 'npm run deploy')
    expect(byBash).toHaveLength(1)
    expect(byBash[0]).toMatchObject({ sessionId: 'sess-bb', kind: 'bash' })
    expect(sessionSearch(runtime, '')).toEqual([])
    expect(sessionSearch(runtime, 'zzz-nothing')).toEqual([])
  })
})
