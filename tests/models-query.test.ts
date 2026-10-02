import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as TestClock from 'effect/testing/TestClock'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { queryModelsView } from '../src/main/application/models-query.js'
import { PricingDiagnostics } from '../src/main/application/pricing-diagnostics.js'
import type { ScopedViewQueryInputs } from '../src/main/application/view-queries.js'
import { capturePricingCatalogue } from '../src/main/pipeline/pricing-calculation.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import {
  LedgerQueries,
  type LedgerQueriesPort,
  type LedgerRequestSnapshotData,
} from '../src/main/store/ledger-ports.js'
import { buildFixtureCachedFile } from './fixtures/cached-file.js'

const directories: string[] = []
const emptyCatalogue = capturePricingCatalogue({
  prices: new Map(),
  overrides: new Map(),
  builtinAliases: {},
  userAliases: {},
  tiers: [],
  routedSegments: new Set(),
})
const queryInputs: ScopedViewQueryInputs = {
  scope: { period: 'lifetime' },
  catalogue: emptyCatalogue,
  proxyPaths: { paths: [], caseSensitive: false },
}

function makeStore(): LedgerStore {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-model-query-'))
  directories.push(directory)
  return new LedgerStore(join(directory, 'ledger.db'))
}

function seedLedger(store: LedgerStore): void {
  store.portIn({
    provider: 'opencode',
    envFingerprint: 'models-query',
    filePath: '/cache/models-query.jsonl',
    verdict: 'new',
    cachedFile: buildFixtureCachedFile(),
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('queryModelsView', () => {
  it('uses snapshot config for all lenses and sees edits on the next request without rescanning', async () => {
    const store = makeStore()
    try {
      seedLedger(store)
      const snapshotReads = vi.fn()
      const reports: string[][] = []
      const run = (scope = queryInputs.scope) =>
        Effect.gen(function* () {
          yield* TestClock.setTime(new Date(2026, 6, 2).getTime())
          const actual = yield* LedgerQueries
          const queries = LedgerQueries.of({
            ...actual,
            getRequestSnapshotData: () =>
              Effect.sync(() => snapshotReads()).pipe(Effect.flatMap(() => actual.getRequestSnapshotData())),
          })
          const diagnostics = PricingDiagnostics.of({
            reportUnpricedModels: models =>
              Effect.sync(() => {
                reports.push([...models])
              }),
          })
          return yield* queryModelsView({ ...queryInputs, scope }).pipe(
            Effect.provideService(LedgerQueries, queries),
            Effect.provideService(PricingDiagnostics, diagnostics),
          )
        }).pipe(Effect.provide(store.portsLayer), Effect.provide(TestClock.layer()))

      const first = await Effect.runPromise(run())
      expect(snapshotReads).toHaveBeenCalledTimes(1)
      expect(first.byModel).toHaveLength(1)
      expect(first.byModel[0]).toMatchObject({
        provider: 'opencode',
        model: 'demo-model',
        inputTokens: 100,
        outputTokens: 55,
        cacheWriteTokens: 0,
        cacheReadTokens: 20,
        costUSD: 0.42,
        calls: 1,
      })
      expect(first.byTask.map(row => row.model)).toEqual(['demo-model'])
      expect(first.audit).toHaveLength(1)
      expect(first.audit[0]).toMatchObject({
        provider: 'opencode',
        model: 'demo-model',
        raw: {
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 20,
          cachedInputTokens: 0,
          webSearchRequests: 0,
        },
        displayed: { inputTokens: 100, outputTokens: 55, cacheWriteTokens: 0, cacheReadTokens: 20 },
        attributedCostUSD: 0.42,
      })

      store.setModelAlias('demo-model', 'claude-sonnet-4-6')
      store.setPriceOverride('claude-sonnet-4-6', {
        inputPricePerMillion: 6,
        outputPricePerMillion: 30,
      })
      const second = await Effect.runPromise(run())

      expect(snapshotReads).toHaveBeenCalledTimes(2)
      expect(second.byModel).toHaveLength(1)
      expect(second.byModel[0]).toMatchObject({
        provider: 'opencode',
        model: 'claude-sonnet-4-6',
        modelDisplayName: 'Sonnet 4.6',
        category: null,
        inputTokens: 100,
        outputTokens: 55,
        cacheWriteTokens: 0,
        cacheReadTokens: 20,
        totalTokens: 175,
        savingsUSD: 0,
        savingsBaselineModel: '',
        calls: 1,
        sourceModels: ['demo-model'],
        override: { inputPricePerMillion: 6, outputPricePerMillion: 30 },
      })
      expect(second.byModel[0]?.costUSD).toBeCloseTo(0.00225, 12)
      expect(second.byTask).toHaveLength(1)
      expect(second.byTask[0]).toMatchObject({
        provider: 'opencode',
        model: 'claude-sonnet-4-6',
        modelDisplayName: 'Sonnet 4.6',
        category: 'refactoring',
        inputTokens: 100,
        outputTokens: 55,
        cacheWriteTokens: 0,
        cacheReadTokens: 20,
        totalTokens: 175,
        savingsUSD: 0,
        savingsBaselineModel: '',
        calls: 1,
        sourceModels: ['demo-model'],
        override: { inputPricePerMillion: 6, outputPricePerMillion: 30 },
      })
      expect(second.byTask[0]?.costUSD).toBeCloseTo(0.00225, 12)
      expect(second.audit).toHaveLength(1)
      expect(second.audit[0]).toMatchObject({
        provider: 'opencode',
        model: 'demo-model',
        modelDisplayName: 'demo-model',
        calls: 1,
        raw: {
          inputTokens: 100,
          outputTokens: 50,
          reasoningTokens: 5,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 20,
          cachedInputTokens: 0,
          webSearchRequests: 0,
        },
        displayed: { inputTokens: 100, outputTokens: 55, cacheWriteTokens: 0, cacheReadTokens: 20 },
        rates: {
          inputCostPerToken: 0.000006,
          outputCostPerToken: 0.00003,
          cacheWriteCostPerToken: 0,
          cacheReadCostPerToken: 0,
          webSearchCostPerRequest: 0,
          fastMultiplier: 1,
        },
        cost: { cacheWrite: 0, cacheRead: 0, webSearch: 0 },
        aliasOf: 'claude-sonnet-4-6',
        override: { inputPricePerMillion: 6, outputPricePerMillion: 30 },
      })
      expect(second.audit[0]?.cost.input).toBeCloseTo(0.0006, 12)
      expect(second.audit[0]?.cost.output).toBeCloseTo(0.00165, 12)
      expect(second.audit[0]?.cost.recomputedTotalUSD).toBeCloseTo(0.00225, 12)
      expect(second.audit[0]?.attributedCostUSD).toBeCloseTo(0.00225, 12)
      expect(first.byModel[0]?.model).toBe('demo-model')
      expect(reports).toEqual([[], []])
    } finally {
      store.close()
    }
  })

  it('captures the clock before the deferred snapshot read', async () => {
    const store = makeStore()
    try {
      seedLedger(store)
      let snapshotReads = 0
      const start = new Date(2026, 6, 1, 23, 59, 59, 999)
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(start.getTime())
          const actual = yield* LedgerQueries
          const queries = LedgerQueries.of({
            ...actual,
            getRequestSnapshotData: () =>
              Effect.gen(function* () {
                snapshotReads += 1
                yield* TestClock.adjust(1)
                return yield* actual.getRequestSnapshotData()
              }),
          })
          const diagnostics = PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void })
          return yield* queryModelsView({
            ...queryInputs,
            scope: { period: 'today' },
          }).pipe(Effect.provideService(LedgerQueries, queries), Effect.provideService(PricingDiagnostics, diagnostics))
        }).pipe(Effect.provide(store.portsLayer), Effect.provide(TestClock.layer())),
      )

      expect(snapshotReads).toBe(1)
      expect(result.byModel.map(row => row.model)).toEqual(['demo-model'])
    } finally {
      store.close()
    }
  })

  it('reports unpriced aggregation names once through PricingDiagnostics', async () => {
    const store = makeStore()
    try {
      seedLedger(store)
      store.setModelAlias('demo-model', 'unpriced-effective-model')
      const reports: string[][] = []
      const payload = await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(new Date(2026, 6, 2).getTime())
          const queries = yield* LedgerQueries
          const diagnostics = PricingDiagnostics.of({
            reportUnpricedModels: models =>
              Effect.sync(() => {
                reports.push([...models])
              }),
          })
          return yield* queryModelsView(queryInputs).pipe(
            Effect.provideService(LedgerQueries, queries),
            Effect.provideService(PricingDiagnostics, diagnostics),
          )
        }).pipe(Effect.provide(store.portsLayer), Effect.provide(TestClock.layer())),
      )

      expect(payload.byModel[0]?.model).toBe('unpriced-effective-model')
      expect(reports).toEqual([['unpriced-effective-model']])
    } finally {
      store.close()
    }
  })

  it('preserves typed SQL and Schema failures from the snapshot port', async () => {
    const store = makeStore()
    try {
      const actual = await Effect.runPromise(
        Effect.flatMap(LedgerQueries, queries => Effect.succeed(queries)).pipe(Effect.provide(store.portsLayer)),
      )
      const sqlFailure = new SqlError.SqlError({
        reason: new SqlError.SqlSyntaxError({ cause: new Error('controlled failure'), message: 'controlled failure' }),
      })
      const diagnostics = PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void })
      const empty: LedgerRequestSnapshotData = {
        sources: [],
        sessions: [],
        turns: [],
        calls: [],
        aliases: [],
        overrides: [],
      }
      const run = (queries: LedgerQueriesPort) =>
        queryModelsView(queryInputs).pipe(
          Effect.provideService(LedgerQueries, LedgerQueries.of(queries)),
          Effect.provideService(PricingDiagnostics, diagnostics),
          Effect.provide(store.portsLayer),
          Effect.provide(TestClock.layer()),
        )

      const sqlQueries = { ...actual, getRequestSnapshotData: () => Effect.fail(sqlFailure) }
      await expect(Effect.runPromise(run(sqlQueries))).rejects.toMatchObject({ _tag: 'SqlError' })

      const schemaQueries = {
        ...actual,
        getRequestSnapshotData: () => Schema.decodeUnknownEffect(Schema.Number)('invalid').pipe(Effect.as(empty)),
      }
      await expect(Effect.runPromise(run(schemaQueries))).rejects.toMatchObject({ _tag: 'SchemaError' })
    } finally {
      store.close()
    }
  })
})
