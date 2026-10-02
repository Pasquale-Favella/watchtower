import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as TestClock from 'effect/testing/TestClock'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PricingDiagnostics } from '../src/main/application/pricing-diagnostics.js'
import { querySpendView } from '../src/main/application/spend-query.js'
import type { ScopedViewQueryInputs } from '../src/main/application/view-queries.js'
import { normalizeProjectPathKey } from '../src/main/pipeline/parser.js'
import { capturePricingCatalogue } from '../src/main/pipeline/pricing-calculation.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import {
  LedgerQueries,
  type LedgerQueriesPort,
  type LedgerRequestSnapshotData,
} from '../src/main/store/ledger-ports.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'

const directories: string[] = []
const catalogue = capturePricingCatalogue({
  prices: new Map(),
  overrides: new Map(),
  builtinAliases: {},
  userAliases: {},
  tiers: [],
  routedSegments: new Set(),
})
const inputs: ScopedViewQueryInputs = {
  scope: { period: 'lifetime' },
  catalogue,
  proxyPaths: { paths: [], caseSensitive: false },
}
const root = process.platform === 'win32' ? 'C:/workspace' : '/workspace'

function makeStore(): LedgerStore {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-spend-query-'))
  directories.push(directory)
  return new LedgerStore(join(directory, 'ledger.db'))
}

function portCall(
  store: LedgerStore,
  options: {
    id: string
    provider?: string
    model?: string
    timestamp: string
    cost?: number
    cwd?: string
  },
): void {
  const provider = options.provider ?? 'opencode'
  const call = {
    ...buildFixtureCachedCall(0),
    provider,
    model: options.model ?? 'demo-model',
    costUSD: options.cost ?? 1,
    timestamp: new Date(options.timestamp).toISOString(),
  }
  const turn = buildFixtureCachedTurn(0, 'task', {
    sessionId: options.id,
    timestamp: call.timestamp,
    calls: [call],
  })
  store.portIn({
    provider,
    envFingerprint: 'spend-query',
    filePath: `/cache/${options.id}.jsonl`,
    verdict: 'new',
    cachedFile: buildFixtureCachedFile({
      canonicalProjectName: 'src',
      canonicalCwd: options.cwd ?? `${root}/project/src`,
      title: '',
      turns: [turn],
    }),
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('querySpendView', () => {
  it('keeps checkout keys separate while merging displayed leaves and preserving alias provenance', async () => {
    const store = makeStore()
    try {
      const firstPath = `${root}/a/src`
      const secondPath = `${root}/b/src`
      portCall(store, {
        id: 'one',
        model: 'demo-model',
        timestamp: new Date(2026, 6, 2, 12).toISOString(),
        cost: 2,
        cwd: firstPath,
      })
      portCall(store, {
        id: 'two',
        model: 'demo-model',
        timestamp: new Date(2026, 6, 2, 12).toISOString(),
        cost: 3,
        cwd: secondPath,
      })
      store.setModelAlias('demo-model', 'claude-sonnet-4-6')
      store.setPriceOverride('claude-sonnet-4-6', {
        inputPricePerMillion: 6,
        outputPricePerMillion: 30,
      })
      const reports: string[][] = []
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(new Date(2026, 6, 2, 12, 30).getTime())
          const queries = yield* LedgerQueries
          const diagnostics = PricingDiagnostics.of({
            reportUnpricedModels: models => Effect.sync(() => reports.push([...models])),
          })
          return yield* querySpendView({
            ...inputs,
            scope: { period: 'lifetime', range: { since: '2026-07-02', until: '2026-07-02' } },
          }).pipe(Effect.provideService(LedgerQueries, queries), Effect.provideService(PricingDiagnostics, diagnostics))
        }).pipe(Effect.provide(store.portsLayer), Effect.provide(TestClock.layer())),
      )

      expect(result.byModel[0]).toMatchObject({
        date: '2026-07-02',
        segments: [{ name: 'Sonnet 4.6', sourceModels: ['demo-model'] }],
      })
      expect(result.byModel[0]?.cost).toBeCloseTo(0.0042, 12)
      expect(result.byModel[0]?.segments[0]?.cost).toBeCloseTo(0.0042, 12)
      expect(result.byProject[0]).toMatchObject({
        date: '2026-07-02',
        segments: [{ name: 'src' }],
      })
      expect(result.byProject[0]?.cost).toBeCloseTo(0.0042, 12)
      expect(result.flow.projects.map(({ id, label }) => ({ id, label }))).toEqual([
        { id: normalizeProjectPathKey(firstPath), label: 'src' },
        { id: normalizeProjectPathKey(secondPath), label: 'src' },
      ])
      expect(result.flow.projects.map(node => node.cost)).toEqual([
        expect.closeTo(0.0021, 12),
        expect.closeTo(0.0021, 12),
      ])
      expect(result.flow.links.map(({ model, project }) => ({ model, project }))).toEqual([
        { model: 'Sonnet 4.6', project: normalizeProjectPathKey(firstPath) },
        { model: 'Sonnet 4.6', project: normalizeProjectPathKey(secondPath) },
      ])
      expect(result.flow.links.map(link => link.cost)).toEqual([expect.closeTo(0.0021, 12), expect.closeTo(0.0021, 12)])
      expect(reports).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('uses one captured clock value before one snapshot load and reports diagnostics once', async () => {
    const store = makeStore()
    try {
      portCall(store, { id: 'midnight', timestamp: new Date(2026, 6, 1, 12).toISOString() })
      const snapshotReads = vi.fn()
      const individualReads = vi.fn()
      const reports: string[][] = []
      const payload = await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(new Date(2026, 6, 1, 23, 59, 59).getTime())
          const actual = yield* LedgerQueries
          const rejectIndividualRead = () =>
            Effect.sync(() => {
              individualReads()
              throw new Error('unexpected individual ledger read')
            })
          const queries = LedgerQueries.of({
            ...actual,
            getSources: rejectIndividualRead,
            getSessions: rejectIndividualRead,
            getTurns: rejectIndividualRead,
            getCalls: rejectIndividualRead,
            getCallFacts: rejectIndividualRead,
            getRequestSnapshotData: () =>
              Effect.gen(function* () {
                snapshotReads()
                yield* TestClock.adjust(2_000)
                return yield* actual.getRequestSnapshotData()
              }),
          })
          const diagnostics = PricingDiagnostics.of({
            reportUnpricedModels: models => Effect.sync(() => reports.push([...models])),
          })
          return yield* querySpendView({ ...inputs, scope: { period: 'today' } }).pipe(
            Effect.provideService(LedgerQueries, queries),
            Effect.provideService(PricingDiagnostics, diagnostics),
          )
        }).pipe(Effect.provide(store.portsLayer), Effect.provide(TestClock.layer())),
      )
      expect(snapshotReads).toHaveBeenCalledTimes(1)
      expect(individualReads).not.toHaveBeenCalled()
      expect(payload.byModel.at(-1)?.date).toBe('2026-07-01')
      expect(reports).toEqual([[]])
    } finally {
      store.close()
    }
  })

  it('applies provider and custom date bounds across year boundaries', async () => {
    const store = makeStore()
    try {
      portCall(store, { id: 'in', provider: 'opencode', timestamp: '2025-12-31T12:00:00Z', cost: 4 })
      portCall(store, { id: 'out', provider: 'claude', timestamp: '2026-01-01T12:00:00Z', cost: 7 })
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(new Date('2026-01-02T12:00:00Z').getTime())
          const queries = yield* LedgerQueries
          return yield* querySpendView({
            ...inputs,
            scope: {
              period: 'lifetime',
              provider: 'opencode',
              range: { since: '2025-12-31', until: '2026-01-01' },
            },
          }).pipe(
            Effect.provideService(LedgerQueries, queries),
            Effect.provideService(
              PricingDiagnostics,
              PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void }),
            ),
          )
        }).pipe(Effect.provide(store.portsLayer), Effect.provide(TestClock.layer())),
      )
      expect(result.byModel).toEqual([
        { date: '2025-12-31', cost: 4, segments: [{ name: 'demo-model', cost: 4 }] },
        { date: '2026-01-01', cost: 0, segments: [] },
      ])
      expect(result.dataStart).toBe('2025-12-31')
      expect(result.flow.models).toEqual([{ id: 'demo-model', label: 'demo-model', cost: 4 }])
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
      const empty: LedgerRequestSnapshotData = {
        sources: [],
        sessions: [],
        turns: [],
        calls: [],
        aliases: [],
        overrides: [],
      }
      const run = (queries: LedgerQueriesPort) =>
        querySpendView(inputs).pipe(
          Effect.provideService(LedgerQueries, LedgerQueries.of(queries)),
          Effect.provideService(PricingDiagnostics, PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void })),
          Effect.provide(store.portsLayer),
          Effect.provide(TestClock.layer()),
        )
      await expect(
        Effect.runPromise(run({ ...actual, getRequestSnapshotData: () => Effect.fail(sqlFailure) })),
      ).rejects.toMatchObject({ _tag: 'SqlError' })
      const malformed = {
        ...actual,
        getRequestSnapshotData: () => Schema.decodeUnknownEffect(Schema.Number)('invalid').pipe(Effect.as(empty)),
      }
      await expect(Effect.runPromise(run(malformed))).rejects.toMatchObject({ _tag: 'SchemaError' })
    } finally {
      store.close()
    }
  })
})
