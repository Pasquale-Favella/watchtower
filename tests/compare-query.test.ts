import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type CompareQueryInputs, queryCompareView } from '../src/main/application/compare-query.js'
import { PricingDiagnostics } from '../src/main/application/pricing-diagnostics.js'
import { capturePricingCatalogue } from '../src/main/pipeline/pricing-calculation.js'
import {
  LedgerConfig,
  LedgerIngest,
  LedgerQueries,
  type LedgerQueriesPort,
  type LedgerRequestSnapshotData,
} from '../src/main/store/ledger-ports.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'
import { openLedgerFixture } from './fixtures/ledger-runtime.js'

const NOW = new Date(2026, 0, 3, 12)

type SessionSpec = {
  sessionId: string
  provider: string
  model: string
  date: string
  cost: number
}

const SPECS: SessionSpec[] = [
  { sessionId: 'alpha-dec31', provider: 'claude', model: 'raw-alpha', date: '2025-12-31', cost: 0.8 },
  { sessionId: 'beta-jan01', provider: 'opencode', model: 'beta-model', date: '2026-01-01', cost: 0.4 },
  { sessionId: 'gamma-jan02', provider: 'claude', model: 'gamma-model', date: '2026-01-02', cost: 0.2 },
]

function seedLedger(runtime: ReturnType<typeof openLedgerFixture>['runtime'], specs = SPECS): void {
  runtime.runSync(
    Effect.gen(function* () {
      const ingest = yield* LedgerIngest
      for (const [index, spec] of specs.entries()) {
        const timestamp = new Date(`${spec.date}T12:00:00`).toISOString()
        const call = {
          ...buildFixtureCachedCall(index),
          provider: spec.provider,
          model: spec.model,
          costUSD: spec.cost,
          timestamp,
        }
        const turn = buildFixtureCachedTurn(index, spec.sessionId, {
          sessionId: spec.sessionId,
          timestamp,
          calls: [call],
        })
        yield* ingest.portIn({
          provider: spec.provider,
          envFingerprint: 'compare-query',
          filePath: `/compare-query/${spec.sessionId}.jsonl`,
          verdict: 'new',
          cachedFile: buildFixtureCachedFile({ title: spec.sessionId, turns: [turn] }),
        })
      }
    }),
  )
}

function getSnapshotData(runtime: ReturnType<typeof openLedgerFixture>['runtime']): Promise<LedgerRequestSnapshotData> {
  return runtime.runPromise(Effect.flatMap(LedgerQueries, queries => queries.getRequestSnapshotData()))
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

function input(scope: CompareQueryInputs['scope'], pair?: CompareQueryInputs['pair']): CompareQueryInputs {
  return {
    catalogue: emptyCatalogue(),
    proxyPaths: { paths: [], caseSensitive: false },
    scope,
    ...(pair ? { pair } : {}),
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
    currentTimeNanos: Effect.succeed(BigInt(readMillis()) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => 0n,
    monotonicTimeNanos: Effect.succeed(0n),
    sleep: () => Effect.void,
  }
}

function runQuery(
  queryPortValue: LedgerQueriesPort,
  diagnostics: PricingDiagnostics['Service'],
  clock: Clock.Clock,
  scope: CompareQueryInputs['scope'],
  pair?: CompareQueryInputs['pair'],
) {
  return queryCompareView(input(scope, pair)).pipe(
    Effect.provideService(LedgerQueries, LedgerQueries.of(queryPortValue)),
    Effect.provideService(PricingDiagnostics, diagnostics),
    Effect.provideService(Clock.Clock, clock),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('queryCompareView', () => {
  it('loads one canonical snapshot and returns literal model and metric data', async () => {
    const { runtime } = openLedgerFixture()
    seedLedger(runtime)
    const data = await getSnapshotData(runtime)
    let snapshotReads = 0
    let bulkReads = 0
    const reports: string[][] = []
    const queries = queryPort(
      () => Effect.sync(() => snapshotReads++).pipe(Effect.as(data)),
      () => bulkReads++,
    )
    const diagnostics = PricingDiagnostics.of({
      reportUnpricedModels: models => Effect.sync(() => reports.push([...models])),
    })
    const payload = await Effect.runPromise(
      runQuery(
        queries,
        diagnostics,
        testClock(() => NOW.getTime()),
        { period: 'lifetime' },
      ),
    )

    expect(
      payload.models.map(({ model, displayName, calls, costUSD, inputTokens, outputTokens }) => ({
        model,
        displayName,
        calls,
        costUSD,
        inputTokens,
        outputTokens,
      })),
    ).toEqual([
      { model: 'raw-alpha', displayName: 'raw-alpha', calls: 1, costUSD: 0.8, inputTokens: 100, outputTokens: 50 },
      { model: 'beta-model', displayName: 'beta-model', calls: 1, costUSD: 0.4, inputTokens: 100, outputTokens: 50 },
      {
        model: 'gamma-model',
        displayName: 'gamma-model',
        calls: 1,
        costUSD: 0.2,
        inputTokens: 100,
        outputTokens: 50,
      },
    ])
    expect(payload.report?.metrics).toEqual([
      { label: 'Calls', valueA: 1, valueB: 1, formatFn: 'number', winner: 'none' },
      { label: 'Total cost', valueA: 0.8, valueB: 0.4, formatFn: 'cost', winner: 'none' },
      { label: 'Input tokens', valueA: 100, valueB: 100, formatFn: 'compact', winner: 'none' },
      { label: 'Output tokens', valueA: 50, valueB: 50, formatFn: 'compact', winner: 'none' },
      { label: 'One-shot rate', valueA: 100, valueB: 100, formatFn: 'percent', winner: 'tie' },
      { label: 'Retry rate', valueA: 0, valueB: 0, formatFn: 'decimal', winner: 'tie' },
      { label: 'Self-correction rate', valueA: 100, valueB: 100, formatFn: 'percent', winner: 'tie' },
      {
        label: 'Cache hit rate',
        valueA: 16.666666666666664,
        valueB: 16.666666666666664,
        formatFn: 'percent',
        winner: 'tie',
      },
    ])
    expect(
      payload.report?.categories.every(
        category =>
          (category.editTurnsA === 0 || category.oneShotRateA === 100) &&
          (category.editTurnsB === 0 || category.oneShotRateB === 100),
      ),
    ).toBe(true)
    expect(payload.report?.workingStyle).toEqual([
      { label: 'Delegation rate', valueA: 0, valueB: 0, formatFn: 'percent' },
      { label: 'Planning rate', valueA: 0, valueB: 0, formatFn: 'percent' },
      { label: 'Avg tools / turn', valueA: 1, valueB: 1, formatFn: 'decimal' },
      { label: 'Fast mode usage', valueA: 0, valueB: 0, formatFn: 'percent' },
    ])
    expect(snapshotReads).toBe(1)
    expect(bulkReads).toBe(0)
    expect(reports).toHaveLength(1)
  })

  it('keeps raw Compare identity while applying captured aliases and overrides to money', async () => {
    const { runtime } = openLedgerFixture()
    seedLedger(runtime, SPECS.slice(0, 2))
    runtime.runSync(
      Effect.gen(function* () {
        const config = yield* LedgerConfig
        yield* config.setModelAlias('raw-alpha', 'beta-model')
        yield* config.setPriceOverride('beta-model', { inputPricePerMillion: 10, outputPricePerMillion: 20 })
      }),
    )
    const data = await getSnapshotData(runtime)
    const queries = queryPort(() => Effect.succeed(data))
    const diagnostics = PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void })
    const catalogue = capturePricingCatalogue({
      prices: new Map(),
      overrides: new Map(),
      builtinAliases: {},
      userAliases: {},
      tiers: [],
      routedSegments: new Set(),
    })
    const payload = await Effect.runPromise(
      queryCompareView({
        ...input({ period: 'lifetime' }),
        catalogue,
      }).pipe(
        Effect.provideService(LedgerQueries, LedgerQueries.of(queries)),
        Effect.provideService(PricingDiagnostics, diagnostics),
        Effect.provideService(
          Clock.Clock,
          testClock(() => NOW.getTime()),
        ),
      ),
    )

    expect(payload.models.map(model => model.model)).toEqual(['beta-model', 'raw-alpha'])
    expect(payload.models[1]).toMatchObject({ model: 'raw-alpha', costUSD: 0.002, inputTokens: 100 })
  })

  it('uses the top two for absent, identical, or unknown pairs', async () => {
    const { runtime } = openLedgerFixture()
    seedLedger(runtime)
    const data = await getSnapshotData(runtime)
    const queries = queryPort(() => Effect.succeed(data))
    const diagnostics = PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void })
    const clock = testClock(() => NOW.getTime())
    for (const pair of [
      undefined,
      { modelA: 'raw-alpha', modelB: 'raw-alpha' },
      { modelA: 'missing', modelB: 'beta-model' },
    ]) {
      const payload = await Effect.runPromise(runQuery(queries, diagnostics, clock, { period: 'lifetime' }, pair))
      expect([payload.report?.modelA.model, payload.report?.modelB.model]).toEqual(['raw-alpha', 'beta-model'])
    }
    const swapped = await Effect.runPromise(
      runQuery(queries, diagnostics, clock, { period: 'lifetime' }, { modelA: 'beta-model', modelB: 'gamma-model' }),
    )
    expect([swapped.report?.modelA.model, swapped.report?.modelB.model]).toEqual(['beta-model', 'gamma-model'])
  })

  it('preserves custom range, provider, and local year-rollover scope semantics', async () => {
    const { runtime } = openLedgerFixture()
    seedLedger(runtime)
    const data = await getSnapshotData(runtime)
    const queries = queryPort(() => Effect.succeed(data))
    const diagnostics = PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void })
    const clock = testClock(() => NOW.getTime())
    const week = await Effect.runPromise(runQuery(queries, diagnostics, clock, { period: 'week' }))
    expect(week.models.map(model => model.model)).toEqual(['raw-alpha', 'beta-model', 'gamma-model'])

    const custom = await Effect.runPromise(
      runQuery(queries, diagnostics, clock, {
        period: 'lifetime',
        provider: 'claude',
        range: { since: '2025-12-31', until: '2026-01-01' },
      }),
    )
    expect(custom.models.map(model => model.model)).toEqual(['raw-alpha'])
    expect(custom.report).toBeNull()
  })

  it('captures the clock once before the deferred snapshot read', async () => {
    const { runtime } = openLedgerFixture()
    seedLedger(runtime, SPECS.slice(0, 2))
    const data = await getSnapshotData(runtime)
    let startSnapshotRead: () => void = () => {}
    const started = new Promise<void>(resolveStarted => {
      startSnapshotRead = resolveStarted
    })
    let finishSnapshotRead: (value: LedgerRequestSnapshotData) => void = () => {}
    const pendingData = new Promise<LedgerRequestSnapshotData>(resolveData => {
      finishSnapshotRead = resolveData
    })
    let nowMillis = new Date(2025, 11, 31, 23, 59).getTime()
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
    nowMillis = new Date(2026, 0, 1, 0, 1).getTime()
    finishSnapshotRead(data)
    const payload = await Effect.runPromise(Fiber.join(fiber))
    expect(clockReads).toBe(1)
    expect(payload.models.map(model => model.model)).toEqual(['raw-alpha'])
  })

  it('preserves typed SQL and Schema failures from the snapshot port', async () => {
    const { runtime } = openLedgerFixture()
    const actual = await runtime.runPromise(Effect.flatMap(LedgerQueries, queries => Effect.succeed(queries)))
    const sqlFailure = new SqlError.SqlError({
      reason: new SqlError.SqlSyntaxError({
        cause: new Error('controlled SQL failure'),
        message: 'controlled failure',
      }),
    })
    const diagnostics = PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void })
    const run = (queries: LedgerQueriesPort) =>
      queryCompareView(input({ period: 'lifetime' })).pipe(
        Effect.provideService(LedgerQueries, LedgerQueries.of(queries)),
        Effect.provideService(PricingDiagnostics, diagnostics),
        Effect.provideService(
          Clock.Clock,
          testClock(() => NOW.getTime()),
        ),
      )

    const sqlExit = await Effect.runPromiseExit(
      run({ ...actual, getRequestSnapshotData: () => Effect.fail(sqlFailure) }),
    )
    expect(sqlExit).toMatchObject({
      _tag: 'Failure',
      cause: { reasons: [{ _tag: 'Fail', error: { _tag: 'SqlError' } }] },
    })

    const schemaFailure = Schema.decodeUnknownEffect(Schema.Number)('invalid').pipe(Effect.as(emptySnapshotData()))
    const schemaExit = await Effect.runPromiseExit(run({ ...actual, getRequestSnapshotData: () => schemaFailure }))
    expect(schemaExit).toMatchObject({
      _tag: 'Failure',
      cause: { reasons: [{ _tag: 'Fail', error: { _tag: 'SchemaError' } }] },
    })
  })
})
