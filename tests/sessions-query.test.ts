import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { afterEach, describe, expect, it } from 'vitest'

import { PricingDiagnostics } from '../src/main/application/pricing-diagnostics.js'
import { querySessionsView } from '../src/main/application/sessions-query.js'
import type { ScopedViewQueryInputs } from '../src/main/application/view-queries.js'
import { capturePricingCatalogue } from '../src/main/pipeline/pricing-calculation.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import type { LedgerQueriesPort } from '../src/main/store/ledger-ports.js'
import { LedgerQueries, type LedgerRequestSnapshotData } from '../src/main/store/ledger-ports.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'

const temporaryDirectories: string[] = []

function makeStore(): LedgerStore {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-sessions-query-'))
  temporaryDirectories.push(directory)
  return new LedgerStore(join(directory, 'ledger.db'))
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

type SessionSpec = {
  sessionId: string
  provider: string
  model: string
  day: [number, number, number]
  cost: number
  title: string
}

const SESSIONS: SessionSpec[] = [
  {
    sessionId: 'session-dec31',
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    day: [2025, 11, 31],
    cost: 0.3,
    title: 'Year end',
  },
  {
    sessionId: 'session-jan01',
    provider: 'opencode',
    model: 'deepseek-v4-flash',
    day: [2026, 0, 1],
    cost: 0.42,
    title: 'New year',
  },
  {
    sessionId: 'session-jan02',
    provider: 'claude',
    model: 'claude-opus-4-6',
    day: [2026, 0, 2],
    cost: 0.55,
    title: 'Next day',
  },
]

function fixtureFor(spec: SessionSpec, index: number) {
  const timestamp = new Date(spec.day[0], spec.day[1], spec.day[2], 12).toISOString()
  const call = {
    ...buildFixtureCachedCall(index),
    provider: spec.provider,
    model: spec.model,
    costUSD: spec.cost,
    timestamp,
  }
  const turn = buildFixtureCachedTurn(index, spec.title, {
    sessionId: spec.sessionId,
    timestamp,
    calls: [call],
  })
  return buildFixtureCachedFile({
    fingerprint: { dev: 42, ino: 4242 + index, mtimeMs: 1_751_300_000_000 + index, sizeBytes: 4096 },
    title: spec.title,
    turns: [turn],
  })
}

async function getSnapshotData(specs: SessionSpec[] = SESSIONS): Promise<LedgerRequestSnapshotData> {
  const store = makeStore()
  try {
    specs.forEach((spec, index) => {
      store.portIn({
        provider: spec.provider,
        envFingerprint: 'sessions-query-test',
        filePath: `/sessions-query/${spec.sessionId}.jsonl`,
        verdict: 'new',
        cachedFile: fixtureFor(spec, index),
      })
    })
    return await Effect.runPromise(
      Effect.flatMap(LedgerQueries, queries => queries.getRequestSnapshotData()).pipe(Effect.provide(store.portsLayer)),
    )
  } finally {
    store.close()
  }
}

function emptySnapshotData(): LedgerRequestSnapshotData {
  return { sources: [], sessions: [], turns: [], calls: [], aliases: [], overrides: [] }
}

function forbiddenBulkRead(): Effect.Effect<never> {
  return Effect.die(new Error('individual bulk read must not be used'))
}

function queryPort(
  getRequestSnapshotData: LedgerQueriesPort['getRequestSnapshotData'],
  onBulkRead: () => void = () => {},
): LedgerQueriesPort {
  const bulkRead = () => {
    onBulkRead()
    return forbiddenBulkRead()
  }
  return {
    hasSources: () => Effect.succeed(false),
    getSources: bulkRead,
    getSessions: bulkRead,
    getTurns: bulkRead,
    getCalls: bulkRead,
    getCallFacts: bulkRead,
    getRequestSnapshotData,
  }
}

function testClock(readMillis: () => number, countRead: () => void = () => {}): Clock.Clock {
  return {
    currentTimeMillisUnsafe: readMillis,
    currentTimeMillis: Effect.sync(() => {
      countRead()
      return readMillis()
    }),
    currentTimeNanosUnsafe: () => BigInt(readMillis()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(readMillis()) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => 0n,
    monotonicTimeNanos: Effect.succeed(0n),
    sleep: () => Effect.void,
  }
}

function emptyCatalogue() {
  return capturePricingCatalogue({
    prices: new Map(),
    overrides: new Map(),
    builtinAliases: {},
    userAliases: {},
    tiers: [],
    routedSegments: new Set(),
  })
}

function input(scope: ScopedViewQueryInputs['scope']): ScopedViewQueryInputs {
  return { catalogue: emptyCatalogue(), proxyPaths: { paths: [], caseSensitive: false }, scope }
}

function runQuery(
  queryPortValue: LedgerQueriesPort,
  diagnostics: PricingDiagnostics['Service'],
  clock: Clock.Clock,
  scope: ScopedViewQueryInputs['scope'],
) {
  return querySessionsView(input(scope)).pipe(
    Effect.provideService(LedgerQueries, LedgerQueries.of(queryPortValue)),
    Effect.provideService(PricingDiagnostics, diagnostics),
    Effect.provideService(Clock.Clock, clock),
  )
}

describe('Sessions query dependency boundary', () => {
  it('keeps the calculation module free of runtime, IO and compatibility-facade imports', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/main/sessions-calculation.ts'), 'utf8')
    const imports = source.match(/^import\s+.*$/gm) ?? []

    expect(imports).toEqual([
      "import type { OverviewScope } from '../shared/schemas/overview.js'",
      "import { overviewDateRange } from './overview-scope.js'",
      "import { type SessionRow, sessionRowFromSummary } from './pipeline/session-row.js'",
      "import { buildSessionSummariesFromSnapshotResult } from './store/aggregate-calculation.js'",
      "import type { LedgerQuerySnapshot } from './store/ledger-query-snapshot.js'",
    ])
  })
})

describe('querySessionsView', () => {
  it('loads one snapshot, avoids bulk reads, reports diagnostics once, and returns literal rows', async () => {
    const data = await getSnapshotData(SESSIONS.slice(1, 2))
    let snapshotReads = 0
    let bulkReads = 0
    const reports: string[][] = []
    const queries = queryPort(
      () => {
        snapshotReads++
        return Effect.succeed(data)
      },
      () => bulkReads++,
    )
    const diagnostics = PricingDiagnostics.of({
      reportUnpricedModels: models => Effect.sync(() => reports.push([...models])),
    })
    const now = new Date(2026, 0, 1, 18)
    const rows = await Effect.runPromise(
      runQuery(
        queries,
        diagnostics,
        testClock(() => now.getTime()),
        { period: 'today' },
      ),
    )

    expect(rows).toEqual([
      {
        sessionId: 'session-jan01',
        title: 'New year',
        project: 'demo-project',
        provider: 'opencode',
        models: ['DeepSeek v4 Flash'],
        cost: 0.42,
        savingsUSD: 0,
        calls: 1,
        turns: 1,
        inputTokens: 100,
        outputTokens: 50,
        startedAt: new Date(2026, 0, 1, 12).toISOString(),
        endedAt: new Date(2026, 0, 1, 12).toISOString(),
      },
    ])
    expect(snapshotReads).toBe(1)
    expect(bulkReads).toBe(0)
    expect(reports).toHaveLength(1)
  })

  it('preserves custom range, provider, and local year-rollover scope semantics', async () => {
    const data = await getSnapshotData()
    const diagnostics = PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void })
    const fixedNow = new Date(2026, 0, 3, 12)
    const queries = queryPort(() => Effect.succeed(data))
    const clock = testClock(() => fixedNow.getTime())

    const week = await Effect.runPromise(runQuery(queries, diagnostics, clock, { period: 'week' }))
    expect(week.map(row => row.sessionId)).toEqual(['session-jan02', 'session-jan01', 'session-dec31'])

    const custom = await Effect.runPromise(
      runQuery(queries, diagnostics, clock, {
        period: 'lifetime',
        provider: 'claude',
        range: { since: '2025-12-31', until: '2026-01-01' },
      }),
    )
    expect(custom.map(row => row.sessionId)).toEqual(['session-dec31'])
  })

  it('captures now once before awaiting a deferred snapshot read', async () => {
    const data = await getSnapshotData()
    let startSnapshotRead: () => void = () => {}
    const started = new Promise<void>(resolveStarted => {
      startSnapshotRead = resolveStarted
    })
    let finishSnapshotRead: (value: LedgerRequestSnapshotData) => void = () => {}
    const pendingData = new Promise<LedgerRequestSnapshotData>(resolveData => {
      finishSnapshotRead = resolveData
    })
    let nowMillis = new Date(2026, 0, 1, 23, 59).getTime()
    let clockReads = 0
    const queries = queryPort(() =>
      Effect.promise(() => {
        startSnapshotRead()
        return pendingData
      }),
    )
    const diagnostics = PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void })
    const fiber = Effect.runFork(
      runQuery(
        queries,
        diagnostics,
        testClock(
          () => nowMillis,
          () => clockReads++,
        ),
        { period: 'today' },
      ),
    )

    await started
    nowMillis = new Date(2026, 0, 2, 1).getTime()
    finishSnapshotRead(data)
    const rows = await Effect.runPromise(Fiber.join(fiber))

    expect(clockReads).toBe(1)
    expect(rows.map(row => row.sessionId)).toEqual(['session-jan01'])
  })

  it('preserves typed SQL and Schema failures from the snapshot port', async () => {
    const diagnostics = PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void })
    const fixedNow = new Date(2026, 0, 1, 12)
    const clock = testClock(() => fixedNow.getTime())
    const sqlFailure = new SqlError.SqlError({
      reason: new SqlError.SqlSyntaxError({
        cause: new Error('controlled SQL failure'),
        message: 'controlled failure',
      }),
    })
    const sqlExit = await Effect.runPromiseExit(
      runQuery(
        queryPort(() => Effect.fail(sqlFailure)),
        diagnostics,
        clock,
        { period: 'lifetime' },
      ),
    )
    expect(sqlExit).toMatchObject({
      _tag: 'Failure',
      cause: { reasons: [{ _tag: 'Fail', error: { _tag: 'SqlError' } }] },
    })

    const schemaFailure = Schema.decodeUnknownEffect(Schema.Number)('invalid').pipe(Effect.as(emptySnapshotData()))
    const schemaExit = await Effect.runPromiseExit(
      runQuery(
        queryPort(() => schemaFailure),
        diagnostics,
        clock,
        { period: 'lifetime' },
      ),
    )
    expect(schemaExit).toMatchObject({
      _tag: 'Failure',
      cause: { reasons: [{ _tag: 'Fail', error: { _tag: 'SchemaError' } }] },
    })
  })
})
