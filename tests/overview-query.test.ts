import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as TestClock from 'effect/testing/TestClock'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryOverview } from '../src/main/application/overview-query.js'
import { PricingDiagnostics } from '../src/main/application/pricing-diagnostics.js'
import { calculateOverviewFromSnapshot, calculateOverviewPayload } from '../src/main/overview-calculation.js'
import { captureLocalModelSavings, setLocalModelSavings } from '../src/main/pipeline/models.js'
import {
  capturePricingCatalogue,
  type ModelCosts,
  type PricingCatalogue,
} from '../src/main/pipeline/pricing-calculation.js'
import type { SessionSummary, TaskCategory } from '../src/main/pipeline/types.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import {
  LedgerQueries,
  type LedgerQueriesPort,
  type LedgerRequestSnapshotData,
} from '../src/main/store/ledger-ports.js'
import { makeLedgerQuerySnapshot } from '../src/main/store/ledger-query-snapshot.js'
import type { OverviewScope } from '../src/shared/schemas/overview.js'
import { buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'

const emptyData: LedgerRequestSnapshotData = {
  sources: [],
  sessions: [],
  turns: [],
  calls: [],
  aliases: [],
  overrides: [],
}
const tempDirs: string[] = []

const zeroRates: ModelCosts = {
  inputCostPerToken: 0,
  outputCostPerToken: 0,
  cacheWriteCostPerToken: 0,
  cacheReadCostPerToken: 0,
  webSearchCostPerRequest: 0,
  fastMultiplier: 1,
}
const categories: TaskCategory[] = [
  'coding',
  'debugging',
  'feature',
  'refactoring',
  'testing',
  'exploration',
  'planning',
  'delegation',
  'git',
  'build/deploy',
  'conversation',
  'brainstorming',
  'general',
]

function catalogue(
  input: {
    prices?: Map<string, ModelCosts>
    overrides?: Map<string, ModelCosts>
    aliases?: Record<string, string>
  } = {},
): PricingCatalogue {
  return capturePricingCatalogue({
    prices: input.prices ?? new Map(),
    overrides: input.overrides ?? new Map(),
    builtinAliases: {},
    userAliases: input.aliases ?? {},
    tiers: [],
    routedSegments: new Set(),
  })
}

function queryInput(scope: OverviewScope = { period: 'lifetime' }) {
  return {
    catalogue: catalogue(),
    proxyPaths: { paths: [], caseSensitive: true },
    scope,
    localSavings: {},
  }
}

function queryPort(
  read: () => Effect.Effect<LedgerRequestSnapshotData, SqlError.SqlError | Schema.SchemaError>,
): LedgerQueriesPort {
  return {
    hasSources: () => Effect.succeed(false),
    getSources: () => Effect.succeed([]),
    getSessions: () => Effect.succeed([]),
    getTurns: () => Effect.succeed([]),
    getCalls: () => Effect.succeed([]),
    getCallFacts: () => Effect.succeed([]),
    getRequestSnapshotData: read,
  }
}

function diagnostics(reports: string[][]) {
  return PricingDiagnostics.of({
    reportUnpricedModels: models => Effect.sync(() => reports.push([...models])),
  })
}

function emptySession(date: Date, overrides: Partial<SessionSummary> = {}): SessionSummary {
  const iso = date.toISOString()
  return {
    sessionId: iso,
    project: 'overview-test',
    firstTimestamp: iso,
    lastTimestamp: iso,
    totalCostUSD: 0.5,
    totalSavingsUSD: 0,
    totalEstimatedCostUSD: 0,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 4,
    turns: [],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: Object.fromEntries(
      categories.map(category => [
        category,
        { turns: 0, costUSD: 0, savingsUSD: 0, retries: 0, editTurns: 0, oneShotTurns: 0 },
      ]),
    ) as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
    subagentBreakdown: {},
    ...overrides,
  }
}

const tokenUsage = (inputTokens: number, outputTokens: number) => ({
  inputTokens,
  outputTokens,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  cachedInputTokens: 0,
  reasoningTokens: 0,
  webSearchRequests: 0,
})

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
  setLocalModelSavings({})
  vi.restoreAllMocks()
})

describe('Overview pure calculation', () => {
  it('preserves scoped local dates, lifetime data start, alias names, free rows and coverage', () => {
    const now = new Date(2026, 6, 2, 12)
    const session = emptySession(new Date(2026, 6, 2, 9), {
      totalCostUSD: 0.5,
      totalInputTokens: 300,
      totalOutputTokens: 150,
      modelBreakdown: {
        'priced-model': { calls: 1, costUSD: 0.5, savingsUSD: 0, tokens: tokenUsage(100, 50) },
        'unknown-display-name': { calls: 1, costUSD: 0, savingsUSD: 0, tokens: tokenUsage(100, 50) },
        'free-alias': { calls: 1, costUSD: 0, savingsUSD: 0, tokens: tokenUsage(50, 25) },
        'local-runtime-model': { calls: 1, costUSD: 0, savingsUSD: 0, tokens: tokenUsage(50, 25) },
      },
      turns: [
        {
          userMessage: 'edit',
          timestamp: new Date(2026, 6, 2, 9).toISOString(),
          sessionId: 'efficiency',
          category: 'coding',
          retries: 1,
          hasEdits: true,
          assistantCalls: [
            {
              provider: 'opencode',
              model: 'efficiency-alias',
              usage: tokenUsage(100, 50),
              costUSD: 0.2,
              tools: ['Edit'],
              mcpTools: [],
              skills: [],
              subagentTypes: [],
              hasAgentSpawn: false,
              hasPlanMode: false,
              speed: 'standard',
              timestamp: new Date(2026, 6, 2, 9).toISOString(),
              bashCommands: [],
              deduplicationKey: 'efficiency-call',
            },
          ],
        },
      ] as SessionSummary['turns'],
    })
    const prices = new Map([['priced-model', { ...zeroRates, inputCostPerToken: 1e-6 }]])
    const overrides = new Map([['free-target', zeroRates]])
    const pricing = catalogue({
      prices,
      overrides,
      aliases: { 'free-alias': 'free-target', 'efficiency-alias': 'gpt-5' },
    })
    setLocalModelSavings({ 'local-runtime-model': 'priced-model' })
    const localSavings = captureLocalModelSavings()

    const result = calculateOverviewPayload({
      sessions: [session],
      scope: { period: 'lifetime', range: { since: '2026-07-02', until: '2026-07-02' } },
      now,
      dataStart: '2026-06-01',
      catalogue: pricing,
      localSavings,
    })

    expect(result.kpis).toMatchObject({ cost: 0.5, calls: 4, sessions: 1, inputTokens: 300, outputTokens: 150 })
    expect(result.dataStart).toBe('2026-06-01')
    expect(result.daily).toEqual([{ date: '2026-07-02', costUSD: 0.5, calls: 4, sessions: 1 }])
    expect(result.models.map(row => row.name)).toEqual([
      'priced-model',
      'unknown-display-name',
      'free-target',
      'local-runtime-model',
    ])
    expect(result.unpricedModels).toEqual([{ model: 'unknown-display-name', calls: 1, tokens: 150 }])
    expect(result.efficiency.pricingCoverage).toBe(0.5)
    expect(result.efficiency.retryTax.byModel[0]?.name).toBe('GPT-5')
  })

  it('keeps a captured catalogue and local mapping isolated from later changes', () => {
    const rates = { ...zeroRates }
    const sourcePrices = new Map([['pricing-target', rates]])
    const aliases = { 'display-alias': 'pricing-target' }
    const capturedCatalogue = catalogue({ prices: sourcePrices, aliases })
    setLocalModelSavings({ 'local-raw-name': 'pricing-target' })
    const capturedLocalSavings = captureLocalModelSavings()

    rates.inputCostPerToken = 4e-6
    sourcePrices.set('new-model', { ...zeroRates, inputCostPerToken: 9e-6 })
    aliases['display-alias'] = 'new-model'
    setLocalModelSavings({})

    const session = emptySession(new Date(2026, 6, 2), {
      totalCostUSD: 0,
      modelBreakdown: {
        'display-alias': { calls: 1, costUSD: 0, savingsUSD: 0, tokens: tokenUsage(10, 0) },
        'local-raw-name': { calls: 1, costUSD: 0, savingsUSD: 0, tokens: tokenUsage(10, 0) },
      },
    })
    const result = calculateOverviewPayload({
      sessions: [session],
      scope: { period: 'lifetime' },
      now: new Date(2026, 6, 2),
      dataStart: '2026-07-02',
      catalogue: capturedCatalogue,
      localSavings: capturedLocalSavings,
    })

    expect(result.models.map(row => row.name)).toEqual(['pricing-target', 'local-raw-name'])
    expect(result.unpricedModels.map(row => row.model)).toEqual(['pricing-target'])
  })
})

describe('Overview application query', () => {
  it('loads one snapshot and reports lifetime and scoped aggregation diagnostics once', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-overview-query-'))
    tempDirs.push(directory)
    const store = new LedgerStore(join(directory, 'ledger.db'))
    try {
      store.portIn({
        provider: 'opencode',
        envFingerprint: 'overview-query',
        filePath: FIXTURE_SOURCE_PATH,
        verdict: 'new',
        cachedFile: buildFixtureCachedFile(),
      })
      store.setModelAlias('demo-model', 'diagnostic-unpriced-target')
      let reads = 0
      const reports: string[][] = []
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const actual = yield* LedgerQueries
          const port = LedgerQueries.of({
            ...actual,
            getRequestSnapshotData: () =>
              Effect.sync(() => reads++).pipe(Effect.andThen(actual.getRequestSnapshotData())),
          })
          return yield* queryOverview(queryInput({ period: 'lifetime', provider: 'claude' })).pipe(
            Effect.provideService(LedgerQueries, port),
            Effect.provideService(PricingDiagnostics, diagnostics(reports)),
          )
        }).pipe(Effect.provide(store.portsLayer)),
      )

      expect(reads).toBe(1)
      expect(result.dataStart).toBe('2026-07-01')
      expect(result.kpis.sessions).toBe(0)
      expect(reports).toEqual([['diagnostic-unpriced-target']])
    } finally {
      store.close()
    }
  })

  it('keeps lifetime data start and diagnostics across finite dates and composite sessions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-overview-lifetime-'))
    tempDirs.push(directory)
    const store = new LedgerStore(join(directory, 'ledger.db'))
    try {
      store.portIn({
        provider: 'opencode',
        envFingerprint: 'overview-lifetime',
        filePath: FIXTURE_SOURCE_PATH,
        verdict: 'new',
        cachedFile: buildFixtureCachedFile(),
      })
      const data = await Effect.runPromise(
        Effect.flatMap(LedgerQueries, queries => queries.getRequestSnapshotData()).pipe(
          Effect.provide(store.portsLayer),
        ),
      )
      const source = data.sources[0]
      const session = data.sessions[0]
      const turn = data.turns[0]
      const call = data.calls[0]
      if (!source || !session || !turn || !call) throw new Error('fixture port did not produce overview rows')
      const withSession = (sessionId: string, sourceId = source.id) => ({ ...session, sourceId, sessionId })
      const withTurn = (sessionId: string, turnIndex: number, timestamp: string, sourceId = source.id) => ({
        ...turn,
        sourceId,
        sessionId,
        turnIndex,
        timestamp,
      })
      const withCall = (
        sessionId: string,
        turnIndex: number,
        callIndex: number,
        timestamp: string,
        model: string,
        provider = 'opencode',
        sourceId = source.id,
      ) => ({ ...call, sourceId, sessionId, turnIndex, callIndex, timestamp, model, provider, baseCostUSD: 0 })

      const epochTime = new Date(1970, 0, 1, 12).toISOString()
      const beforeEpoch = new Date(1969, 11, 31, 23).toISOString()
      const futureTime = new Date(2026, 6, 11, 12).toISOString()
      const secondSource = { ...source, id: source.id + 1, provider: 'claude' }
      const variantData = {
        ...data,
        aliases: [...data.aliases, { model: 'duplicate-id-model', aliasOf: 'diagnostic-claude-target' }],
        sources: [...data.sources, secondSource],
        sessions: [
          ...data.sessions,
          withSession('epoch-session'),
          withSession('before-epoch-first-call'),
          withSession('same-index-first-by-row'),
          withSession('malformed-first-call'),
          withSession('future-session'),
          withSession(session.sessionId, secondSource.id),
        ],
        turns: [
          ...data.turns,
          withTurn('epoch-session', 0, epochTime),
          withTurn('before-epoch-first-call', 0, beforeEpoch),
          withTurn('same-index-first-by-row', 0, beforeEpoch),
          withTurn('malformed-first-call', 0, 'invalid timestamp'),
          withTurn('future-session', 0, futureTime),
          withTurn(session.sessionId, 0, epochTime, secondSource.id),
        ],
        calls: [
          ...data.calls,
          withCall('epoch-session', 0, 0, epochTime, 'epoch-model'),
          withCall('before-epoch-first-call', 0, 0, beforeEpoch, 'before-epoch-model'),
          withCall('before-epoch-first-call', 0, 1, epochTime, 'later-call-model'),
          withCall('same-index-first-by-row', 0, 0, beforeEpoch, 'first-row-model'),
          withCall('same-index-first-by-row', 0, 0, epochTime, 'second-row-model'),
          withCall('malformed-first-call', 0, 0, 'invalid timestamp', 'malformed-model'),
          withCall('malformed-first-call', 0, 1, epochTime, 'later-malformed-call-model'),
          withCall('future-session', 0, 0, futureTime, 'future-model'),
          withCall(session.sessionId, 0, 0, epochTime, 'duplicate-id-model', 'claude', secondSource.id),
        ],
      }
      const snapshot = makeLedgerQuerySnapshot({
        ...variantData,
        catalogue: catalogue(),
        proxyPaths: { paths: [], caseSensitive: true },
      })
      const result = calculateOverviewFromSnapshot(
        snapshot,
        { period: 'lifetime', provider: 'opencode' },
        new Date(2026, 6, 10, 12),
        {},
      )
      expect(result.value.dataStart).toBe('1970-01-01')
      expect(result.value.kpis.sessions).toBe(2)
      expect(result.unpricedModels).toEqual(['diagnostic-claude-target'])

      const reversedCalls = makeLedgerQuerySnapshot({
        ...variantData,
        calls: [...variantData.calls, withCall('epoch-session', 0, 1, beforeEpoch, 'earlier-later-call')],
        catalogue: catalogue(),
        proxyPaths: { paths: [], caseSensitive: true },
      })
      // The first call admits the turn; every call then participates in the
      // session's timestamp. The previous summary path reports this literal day.
      expect(
        calculateOverviewFromSnapshot(reversedCalls, { period: 'lifetime' }, new Date(2026, 6, 10, 12), {}).value
          .dataStart,
      ).toBe('1969-12-31')

      const emptyLastTimestamp = makeLedgerQuerySnapshot({
        ...data,
        turns: [{ ...turn, timestamp: new Date(2001, 1, 3, 12).toISOString() }],
        calls: [...data.calls, { ...call, callIndex: 1, timestamp: '' }],
        catalogue: catalogue(),
        proxyPaths: { paths: [], caseSensitive: true },
      })
      expect(
        calculateOverviewFromSnapshot(emptyLastTimestamp, { period: 'lifetime' }, new Date(2026, 6, 10, 12), {}).value
          .dataStart,
      ).toBe('2001-02-03')

      const orphanSourceId = source.id + 1000
      const orphanRows = makeLedgerQuerySnapshot({
        ...data,
        sessions: [...data.sessions, withSession('orphan-source-session', orphanSourceId)],
        turns: [...data.turns, withTurn('orphan-source-session', 0, epochTime, orphanSourceId)],
        calls: [
          ...data.calls,
          withCall('orphan-source-session', 0, 0, epochTime, 'orphan-model', 'opencode', orphanSourceId),
        ],
        catalogue: catalogue(),
        proxyPaths: { paths: [], caseSensitive: true },
      })
      expect(
        calculateOverviewFromSnapshot(orphanRows, { period: 'lifetime' }, new Date(2026, 6, 10, 12), {}).value
          .dataStart,
      ).toBe('1970-01-01')
    } finally {
      store.close()
    }
  })

  it('uses the time captured before a deferred snapshot load', async () => {
    const reports: string[][] = []
    const payload = await Effect.runPromise(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<undefined>()
        const release = yield* Deferred.make<undefined>()
        const read = () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            return emptyData
          })
        const port = LedgerQueries.of(queryPort(read))
        const task = queryOverview(queryInput()).pipe(
          Effect.provideService(LedgerQueries, port),
          Effect.provideService(PricingDiagnostics, diagnostics(reports)),
        )
        yield* TestClock.setTime(new Date(2026, 5, 15, 12).getTime())
        const fiber = yield* Effect.forkChild(task)
        yield* Deferred.await(entered)
        yield* TestClock.adjust('24 hours')
        yield* Deferred.succeed(release, undefined)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )

    expect(payload.daily.at(-1)?.date).toBe('2026-06-15')
  })

  it('preserves typed SQL and Schema failures from the canonical snapshot load', async () => {
    const failure = new SqlError.SqlError({
      reason: new SqlError.SqlSyntaxError({ cause: new Error('controlled failure'), message: 'controlled failure' }),
    })
    const badSchema = Schema.decodeUnknownEffect(Schema.Number)('invalid').pipe(Effect.as(emptyData))
    const sqlProgram = queryOverview(queryInput()).pipe(
      Effect.provideService(LedgerQueries, LedgerQueries.of(queryPort(() => Effect.fail(failure)))),
      Effect.provideService(PricingDiagnostics, diagnostics([])),
    )
    const schemaProgram = queryOverview(queryInput()).pipe(
      Effect.provideService(LedgerQueries, LedgerQueries.of(queryPort(() => badSchema))),
      Effect.provideService(PricingDiagnostics, diagnostics([])),
    )

    await expect(Effect.runPromise(sqlProgram)).rejects.toMatchObject({ _tag: 'SqlError' })
    await expect(Effect.runPromise(schemaProgram)).rejects.toMatchObject({ _tag: 'SchemaError' })
  })
})
