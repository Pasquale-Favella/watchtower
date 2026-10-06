import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Clock from 'effect/Clock'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PricingDiagnostics } from '../src/main/application/pricing-diagnostics.js'
import { queryPullRequestsView } from '../src/main/application/pull-requests-query.js'
import type { ScopedViewQueryInputs } from '../src/main/application/view-queries.js'
import { capturePricingCatalogue } from '../src/main/pipeline/pricing-calculation.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import {
  LedgerQueries,
  type LedgerQueriesPort,
  type LedgerRequestSnapshotData,
} from '../src/main/store/ledger-ports.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'

const directories: string[] = []
const PR_A = 'https://github.com/acme/repo/pull/12'
const PR_B = 'https://github.com/acme/repo/pull/34'
const PR_C = 'https://github.com/acme/repo/pull/56'

function makeStore(): LedgerStore {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-pr-query-'))
  directories.push(directory)
  return new LedgerStore(join(directory, 'ledger.db'))
}

function emptySnapshotData(): LedgerRequestSnapshotData {
  return { sources: [], sessions: [], turns: [], calls: [], aliases: [], overrides: [] }
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

const queryInputs: ScopedViewQueryInputs = {
  scope: { period: 'lifetime' },
  catalogue: emptyCatalogue(),
  proxyPaths: { paths: [], caseSensitive: false },
}

function seedFile(
  store: LedgerStore,
  input: {
    provider: string
    sessionId: string
    dates: string[]
    prLinks: string[]
    prRefs?: Array<string[] | undefined>
  },
): void {
  const turns = input.dates.map((date, index) => {
    const timestamp = new Date(`${date}T12:00:00.000Z`).toISOString()
    const call = {
      ...buildFixtureCachedCall(index),
      provider: input.provider,
      timestamp,
      deduplicationKey: `${input.provider}:${input.sessionId}:${index}`,
    }
    return buildFixtureCachedTurn(index, 'Refactor the auth module', {
      sessionId: input.sessionId,
      timestamp,
      calls: [call],
      ...(input.prRefs?.[index] ? { prRefs: input.prRefs[index] } : {}),
    })
  })
  store.portIn({
    provider: input.provider,
    envFingerprint: 'pr-query',
    filePath: `/pr-query/${input.provider}/${input.sessionId}.jsonl`,
    verdict: 'new',
    cachedFile: buildFixtureCachedFile({ turns, prLinks: input.prLinks }),
  })
}

function emptyDiagnostics(reports: string[][] = []) {
  return PricingDiagnostics.of({
    reportUnpricedModels: models => Effect.sync(() => reports.push([...models])),
  })
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

function queryPort(
  getRequestSnapshotData: LedgerQueriesPort['getRequestSnapshotData'],
  onBulkRead: () => void = () => {},
): LedgerQueriesPort {
  const forbiddenBulkRead = () => {
    onBulkRead()
    return Effect.die(new Error('individual ledger reads must not be used'))
  }
  return {
    hasSources: () => Effect.succeed(false),
    getSources: forbiddenBulkRead,
    getSessions: forbiddenBulkRead,
    getTurns: forbiddenBulkRead,
    getCalls: forbiddenBulkRead,
    getCallFacts: forbiddenBulkRead,
    getRequestSnapshotData,
  }
}

function runQuery(
  inputs: ScopedViewQueryInputs,
  queries: LedgerQueriesPort,
  diagnostics: PricingDiagnostics['Service'],
  clock: Clock.Clock,
) {
  return queryPullRequestsView(inputs).pipe(
    Effect.provideService(LedgerQueries, LedgerQueries.of(queries)),
    Effect.provideService(PricingDiagnostics, diagnostics),
    Effect.provideService(Clock.Clock, clock),
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('queryPullRequestsView', () => {
  it('loads one snapshot and applies provider, custom-day, carry-forward, legacy, and repricing rules', async () => {
    const store = makeStore()
    try {
      seedFile(store, {
        provider: 'claude',
        sessionId: 'parent',
        dates: ['2025-12-31', '2026-01-02', '2026-01-03'],
        prLinks: [PR_A, PR_B],
        prRefs: [[PR_A], undefined, [PR_B]],
      })
      seedFile(store, {
        provider: 'claude',
        sessionId: 'legacy',
        dates: ['2026-01-02'],
        prLinks: [PR_C],
      })
      seedFile(store, {
        provider: 'opencode',
        sessionId: 'other-provider',
        dates: ['2026-01-02'],
        prLinks: [PR_C],
        prRefs: [[PR_C]],
      })
      store.setModelAlias('demo-model', 'effective-model')
      store.setPriceOverride('effective-model', { inputPricePerMillion: 3, outputPricePerMillion: 15 })

      const actual = await Effect.runPromise(
        Effect.flatMap(LedgerQueries, queries => queries.getRequestSnapshotData()).pipe(
          Effect.provide(store.portsLayer),
        ),
      )
      let snapshotReads = 0
      let bulkReads = 0
      const queries = queryPort(
        () => Effect.sync(() => snapshotReads++).pipe(Effect.as(actual)),
        () => bulkReads++,
      )
      const reports: string[][] = []
      const payload = await Effect.runPromise(
        runQuery(
          {
            ...queryInputs,
            scope: {
              period: 'lifetime',
              provider: 'claude',
              range: { since: '2026-01-02', until: '2026-01-02' },
            },
          },
          queries,
          emptyDiagnostics(reports),
          testClock(() => new Date('2026-01-02T12:00:00Z').getTime()),
        ),
      )

      expect(payload.rows.map(row => row.url).sort()).toEqual([PR_A, PR_C].sort())
      const carried = payload.rows.find(row => row.url === PR_A)
      expect(carried).toMatchObject({
        label: 'acme/repo#12',
        sessions: 1,
        calls: 1,
        firstStarted: '2026-01-02T12:00:00.000Z',
        lastEnded: '2026-01-02T12:00:00.000Z',
        models: ['effective-model'],
        modelProvenance: { 'effective-model': ['demo-model'] },
        categories: [{ name: 'Refactoring' }],
      })
      expect(carried?.cost).toBeCloseTo(0.00105, 12)
      expect(carried?.categories?.[0]?.cost).toBeCloseTo(0.00105, 12)
      const legacy = payload.rows.find(row => row.url === PR_C)
      expect(legacy).toMatchObject({
        label: 'acme/repo#56',
        sessions: 1,
        calls: 1,
        firstStarted: '2026-01-02T12:00:00.000Z',
        lastEnded: '2026-01-02T12:00:00.000Z',
        models: ['effective-model'],
        modelProvenance: { 'effective-model': ['demo-model'] },
      })
      expect(legacy?.cost).toBeCloseTo(0.00105, 12)
      expect(legacy?.categories).toBeUndefined()
      expect(payload).toMatchObject({
        distinctSessions: 2,
        subagentSessions: 0,
        unattributedCost: 0,
      })
      expect(payload.distinctCost).toBeCloseTo(0.0021, 12)
      expect(payload.attributedCost).toBeCloseTo(0.0021, 12)
      expect(snapshotReads).toBe(1)
      expect(bulkReads).toBe(0)
      expect(reports).toEqual([[]])
    } finally {
      store.close()
    }
  })

  it('uses the day captured before a deferred snapshot read across a midnight boundary', async () => {
    const store = makeStore()
    try {
      seedFile(store, {
        provider: 'claude',
        sessionId: 'day-one',
        dates: ['2026-01-02'],
        prLinks: [PR_A],
        prRefs: [[PR_A]],
      })
      seedFile(store, {
        provider: 'claude',
        sessionId: 'day-two',
        dates: ['2026-01-03'],
        prLinks: [PR_B],
        prRefs: [[PR_B]],
      })
      const actual = await Effect.runPromise(
        Effect.flatMap(LedgerQueries, queries => queries.getRequestSnapshotData()).pipe(
          Effect.provide(store.portsLayer),
        ),
      )

      let nowMillis = new Date('2026-01-02T10:00:00Z').getTime()
      let clockReads = 0
      const payload = await Effect.runPromise(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<undefined>()
          const release = yield* Deferred.make<undefined>()
          const queries = queryPort(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined)
              yield* Deferred.await(release)
              return actual
            }),
          )
          const fiber = yield* Effect.forkChild(
            runQuery(
              { ...queryInputs, scope: { period: 'today' } },
              queries,
              emptyDiagnostics(),
              testClock(
                () => nowMillis,
                () => clockReads++,
              ),
            ),
          )
          yield* Deferred.await(entered)
          nowMillis = new Date('2026-01-03T10:00:00Z').getTime()
          yield* Deferred.succeed(release, undefined)
          return yield* Fiber.join(fiber)
        }),
      )

      expect(clockReads).toBe(1)
      expect(payload.rows.map(row => row.url)).toEqual([PR_A])
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
      const diagnostics = emptyDiagnostics()
      const run = (queries: LedgerQueriesPort) =>
        runQuery(
          queryInputs,
          queries,
          diagnostics,
          testClock(() => new Date('2026-01-02T12:00:00Z').getTime()),
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
    } finally {
      store.close()
    }
  })
})
