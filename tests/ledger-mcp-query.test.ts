import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as SqlError from 'effect/sql/SqlError'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryLedgerMcpCalls, queryLedgerMcpScope } from '../src/main/application/ledger-mcp-query.js'
import { PricingDiagnostics } from '../src/main/application/pricing-diagnostics.js'
import { captureModelPricingCatalogue, captureProxyPaths } from '../src/main/pipeline/models.js'
import { LedgerConfig, LedgerIngest, LedgerQueries } from '../src/main/store/ledger-ports.js'
import { ledgerMcpCallsSchema, ledgerMcpScopeResultSchema } from '../src/shared/schemas/ledger-mcp-results.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'
import { openLedgerFixture } from './fixtures/ledger-runtime.js'

type TestRuntime = ReturnType<typeof openLedgerFixture>['runtime']

function portSession(
  runtime: TestRuntime,
  options: { provider: string; sessionId: string; path: string; timestamp: string; calls: number },
): void {
  const calls = Array.from({ length: options.calls }, (_, index) => ({
    ...buildFixtureCachedCall(index),
    provider: options.provider,
    model: index % 2 === 0 ? 'mcp-raw-model' : 'mcp-other-model',
    timestamp: options.timestamp,
    deduplicationKey: `${options.sessionId}-call-${index}`,
    tools: [index % 2 === 0 ? 'Read' : 'Edit'],
  }))
  const turn = buildFixtureCachedTurn(0, 'Implement a feature', {
    sessionId: options.sessionId,
    timestamp: options.timestamp,
    calls,
  })
  runtime.runSync(
    Effect.flatMap(LedgerIngest, ingest =>
      ingest.portIn({
        provider: options.provider,
        envFingerprint: 'ledger-mcp-query',
        filePath: options.path,
        project: 'mcp-project',
        verdict: 'new',
        cachedFile: buildFixtureCachedFile({
          canonicalProjectName: 'mcp-project',
          turns: [turn],
        }),
      }),
    ),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('MCP scope and calls queries', () => {
  it('uses one captured snapshot and preserves in-range source/session counts and filters', async () => {
    const { runtime } = openLedgerFixture()
    portSession(runtime, {
      provider: 'claude',
      sessionId: 'shared-session',
      path: '/cache/claude.jsonl',
      timestamp: '2026-07-01T10:00:00.000Z',
      calls: 2,
    })
    portSession(runtime, {
      provider: 'opencode',
      sessionId: 'shared-session',
      path: '/cache/opencode.jsonl',
      timestamp: '2026-07-02T10:00:00.000Z',
      calls: 1,
    })
    runtime.runSync(
      Effect.flatMap(LedgerConfig, config => config.setModelAlias('mcp-raw-model', 'mcp-effective-model')),
    )
    runtime.runSync(
      Effect.flatMap(LedgerConfig, config =>
        config.setPriceOverride('mcp-effective-model', { inputPricePerMillion: 10, outputPricePerMillion: 20 }),
      ),
    )
    const category = runtime.runSync(Effect.flatMap(LedgerQueries, queries => queries.getTurns()))[0]?.category
    if (category === undefined) throw new Error('The fixture turn was not ported')

    let snapshotReads = 0
    const reports: string[][] = []
    const baseInputs = { catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() }
    const run = Effect.gen(function* () {
      const actual = yield* LedgerQueries
      const queries = LedgerQueries.of({
        ...actual,
        getRequestSnapshotData: () =>
          Effect.sync(() => snapshotReads++).pipe(Effect.andThen(actual.getRequestSnapshotData())),
      })
      const diagnostics = PricingDiagnostics.of({
        reportUnpricedModels: models => Effect.sync(() => reports.push([...models])),
      })
      const scope = yield* queryLedgerMcpScope({ ...baseInputs, scope: { period: 'lifetime' } }).pipe(
        Effect.provideService(LedgerQueries, queries),
        Effect.provideService(PricingDiagnostics, diagnostics),
      )
      const filteredCalls = yield* queryLedgerMcpCalls({
        ...baseInputs,
        scope: { period: 'lifetime', provider: 'claude' },
        model: 'mcp-effective-model',
        project: 'mcp-project',
        category,
        tool: 'Read',
      }).pipe(Effect.provideService(LedgerQueries, queries), Effect.provideService(PricingDiagnostics, diagnostics))
      return { scope, filteredCalls }
    })

    const { scope, filteredCalls } = await runtime.runPromise(run)
    expect(snapshotReads).toBe(2)
    expect(reports).toHaveLength(2)
    expect(scope).toMatchObject({
      scope: { period: 'lifetime' },
      sessions: 2,
      calls: 3,
      providers: ['claude', 'opencode'],
    })
    expect(Schema.decodeUnknownSync(ledgerMcpScopeResultSchema)(scope)).toEqual(scope)
    expect(filteredCalls).toHaveLength(1)
    expect(filteredCalls[0]).toMatchObject({
      provider: 'claude',
      model: 'mcp-effective-model',
      project: 'mcp-project',
      tools: ['Read'],
    })
    expect(Schema.decodeUnknownSync(ledgerMcpCallsSchema)(filteredCalls)).toEqual(filteredCalls)
  })

  it('uses per-call date filtering, default limit, and descending timestamp order', async () => {
    const { runtime } = openLedgerFixture()
    portSession(runtime, {
      provider: 'claude',
      sessionId: 'older-session',
      path: '/cache/older.jsonl',
      timestamp: '2026-06-30T10:00:00.000Z',
      calls: 1,
    })
    portSession(runtime, {
      provider: 'claude',
      sessionId: 'newer-session',
      path: '/cache/newer.jsonl',
      timestamp: '2026-07-01T10:00:00.000Z',
      calls: 2,
    })
    let snapshotReads = 0
    const run = Effect.gen(function* () {
      const actual = yield* LedgerQueries
      const queries = LedgerQueries.of({
        ...actual,
        getRequestSnapshotData: () =>
          Effect.sync(() => snapshotReads++).pipe(Effect.andThen(actual.getRequestSnapshotData())),
      })
      return yield* queryLedgerMcpCalls({
        catalogue: captureModelPricingCatalogue(),
        proxyPaths: captureProxyPaths(),
        scope: { period: 'lifetime', range: { since: '2026-07-01', until: '2026-07-01' } },
      }).pipe(
        Effect.provideService(LedgerQueries, queries),
        Effect.provideService(PricingDiagnostics, PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void })),
      )
    })

    const calls = await runtime.runPromise(run)
    expect(snapshotReads).toBe(1)
    expect(calls).toHaveLength(2)
    expect(calls.map(call => call.timestamp)).toEqual(['2026-07-01T10:00:00.000Z', '2026-07-01T10:00:00.000Z'])
  })

  it('keeps stable ties, defaults to 20 rows, caps supplied results at 200, and filters call timestamps inclusively', async () => {
    const { runtime } = openLedgerFixture()
    const inclusiveEnd = new Date(2026, 6, 31, 23, 59, 59, 999).toISOString()
    const afterEnd = new Date(2026, 7, 1).toISOString()
    const calls = Array.from({ length: 207 }, (_, index) => {
      const timestamp = index < 205 ? inclusiveEnd : index === 205 ? afterEnd : 'not-a-timestamp'
      return {
        ...buildFixtureCachedCall(index),
        provider: 'claude',
        model: 'mcp-raw-model',
        timestamp,
        usage: { ...buildFixtureCachedCall(index).usage, inputTokens: index },
        deduplicationKey: `boundary-call-${index}`,
      }
    })
    const turn = buildFixtureCachedTurn(0, 'Check date edges', {
      sessionId: 'boundary-session',
      timestamp: '2026-07-31T12:00:00.000Z',
      calls,
    })
    runtime.runSync(
      Effect.flatMap(LedgerIngest, ingest =>
        ingest.portIn({
          provider: 'claude',
          envFingerprint: 'query-boundary',
          filePath: '/cache/query-boundary.jsonl',
          verdict: 'new',
          cachedFile: buildFixtureCachedFile({ turns: [turn] }),
        }),
      ),
    )
    expect(runtime.runSync(Effect.flatMap(LedgerQueries, queries => queries.getCallFacts()))).toHaveLength(207)
    let snapshotReads = 0
    const run = async (limit?: number) => {
      const all = await runtime.runPromise(
        Effect.gen(function* () {
          const actual = yield* LedgerQueries
          const queries = LedgerQueries.of({
            ...actual,
            getRequestSnapshotData: () =>
              Effect.sync(() => snapshotReads++).pipe(Effect.andThen(actual.getRequestSnapshotData())),
          })
          return yield* queryLedgerMcpCalls({
            catalogue: captureModelPricingCatalogue(),
            proxyPaths: captureProxyPaths(),
            scope: { period: 'lifetime', range: { since: '2026-07-31', until: '2026-07-31' } },
            ...(limit === undefined ? {} : { limit }),
          }).pipe(
            Effect.provideService(LedgerQueries, queries),
            Effect.provideService(
              PricingDiagnostics,
              PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void }),
            ),
          )
        }),
      )
      return all
    }

    const defaults = await run()
    expect(defaults).toHaveLength(20)
    expect(defaults.map(call => call.tokens.input)).toEqual(Array.from({ length: 20 }, (_, index) => index))
    const maximum = await run(200)
    expect(maximum).toHaveLength(200)
    expect(maximum.map(call => call.tokens.input)).toEqual(Array.from({ length: 200 }, (_, index) => index))
    expect(snapshotReads).toBe(2)
  })

  it('keeps SQL and output-schema failures typed and reports diagnostics after snapshot loading', async () => {
    const { runtime } = openLedgerFixture()
    portSession(runtime, {
      provider: 'claude',
      sessionId: 'schema-failure',
      path: '/cache/schema-failure.jsonl',
      timestamp: '2026-07-01T10:00:00.000Z',
      calls: 1,
    })
    const actual = await runtime.runPromise(Effect.flatMap(LedgerQueries, queries => Effect.succeed(queries)))
    const sqlFailure = new SqlError.SqlError({
      reason: new SqlError.SqlSyntaxError({ cause: new Error('controlled failure'), message: 'controlled failure' }),
    })
    let diagnosticCalls = 0
    const diagnostics = PricingDiagnostics.of({
      reportUnpricedModels: () => Effect.sync(() => diagnosticCalls++),
    })
    const run = (queries: typeof actual) =>
      queryLedgerMcpCalls({
        catalogue: captureModelPricingCatalogue(),
        proxyPaths: captureProxyPaths(),
        scope: { period: 'lifetime' },
      }).pipe(
        Effect.provideService(LedgerQueries, LedgerQueries.of(queries)),
        Effect.provideService(PricingDiagnostics, diagnostics),
      )

    await expect(
      runtime.runPromise(run({ ...actual, getRequestSnapshotData: () => Effect.fail(sqlFailure) })),
    ).rejects.toMatchObject({ _tag: 'SqlError' })

    const validSnapshot = await runtime.runPromise(actual.getRequestSnapshotData())
    const malformedSnapshot = {
      ...validSnapshot,
      calls: validSnapshot.calls.map(call => ({ ...call, tools: null as unknown as string[] })),
    }
    const malformed = {
      ...actual,
      getRequestSnapshotData: () => Effect.succeed(malformedSnapshot),
    }
    await expect(runtime.runPromise(run(malformed))).rejects.toMatchObject({ _tag: 'SchemaError' })
    expect(diagnosticCalls).toBe(1)
  })

  it('propagates interruption while loading the canonical snapshot', async () => {
    const { runtime } = openLedgerFixture()
    let snapshotReads = 0
    let diagnosticCalls = 0
    const exit = await runtime.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<undefined>()
        const actual = yield* LedgerQueries
        const queries = LedgerQueries.of({
          ...actual,
          getRequestSnapshotData: () =>
            Effect.sync(() => snapshotReads++).pipe(
              Effect.andThen(Deferred.succeed(entered, undefined)),
              Effect.andThen(Effect.never),
            ),
        })
        const diagnostics = PricingDiagnostics.of({
          reportUnpricedModels: () => Effect.sync(() => diagnosticCalls++),
        })
        const fiber = yield* Effect.forkChild(
          queryLedgerMcpScope({
            catalogue: captureModelPricingCatalogue(),
            proxyPaths: captureProxyPaths(),
            scope: { period: 'lifetime' },
          }).pipe(
            Effect.provideService(LedgerQueries, queries),
            Effect.provideService(PricingDiagnostics, diagnostics),
          ),
        )
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }),
    )
    expect(snapshotReads).toBe(1)
    expect(exit._tag).toBe('Failure')
    expect(diagnosticCalls).toBe(0)
  })
})
