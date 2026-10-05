import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it } from 'vitest'

import { PricingDiagnostics } from '../src/main/application/pricing-diagnostics.js'
import { RepositoryInspection, RepositoryInspectionError } from '../src/main/application/repository-inspection.js'
import type { ScopedViewQueryInputs } from '../src/main/application/view-queries.js'
import { queryYieldView } from '../src/main/application/yield-query.js'
import { capturePricingCatalogue } from '../src/main/pipeline/pricing-calculation.js'
import type { SessionSummary } from '../src/main/pipeline/types.js'
import {
  LedgerQueries,
  type LedgerQueriesPort,
  type LedgerRequestSnapshotData,
} from '../src/main/store/ledger-ports.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import { attributeYieldCommits, calculateYieldPayload, categorizeYieldSession } from '../src/main/yield-calculation.js'
import { buildFixtureCachedFile } from './fixtures/cached-file.js'

const NOW = new Date('2026-10-05T12:00:00.000Z')
const directories: string[] = []
const stores: LedgerStore[] = []

function makeStore(): LedgerStore {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-yield-query-'))
  directories.push(directory)
  const store = new LedgerStore(join(directory, 'ledger.db'))
  stores.push(store)
  return store
}

afterEach(() => {
  try {
    let closeFailure: unknown
    for (const store of stores.splice(0)) {
      try {
        store.close()
      } catch (error) {
        closeFailure ??= error
      }
    }
    if (closeFailure !== undefined) throw closeFailure
  } finally {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  }
})

function session(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: 'session-1',
    project: 'project',
    firstTimestamp: '2026-10-05T10:00:00.000Z',
    lastTimestamp: '2026-10-05T10:30:00.000Z',
    totalCostUSD: 2,
    totalSavingsUSD: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    apiCalls: 0,
    turns: [],
    modelBreakdown: {},
    toolBreakdown: {},
    mcpBreakdown: {},
    bashBreakdown: {},
    categoryBreakdown: {} as SessionSummary['categoryBreakdown'],
    skillBreakdown: {},
    subagentBreakdown: {},
    ...overrides,
  }
}

function emptyData(): LedgerRequestSnapshotData {
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

function testClock(read: () => number, count: () => void): Clock.Clock {
  return {
    currentTimeMillisUnsafe: read,
    currentTimeMillis: Effect.sync(() => {
      count()
      return read()
    }),
    currentTimeNanosUnsafe: () => BigInt(read()) * 1_000_000n,
    currentTimeNanos: Effect.succeed(BigInt(read()) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => 0n,
    monotonicTimeNanos: Effect.succeed(0n),
    sleep: () => Effect.void,
  }
}

function queryPort(data: LedgerRequestSnapshotData, onSnapshot: () => void): LedgerQueriesPort {
  const noBulkRead = () => Effect.die(new Error('bulk ledger reads are forbidden'))
  return {
    getSources: noBulkRead,
    getSessions: noBulkRead,
    getTurns: noBulkRead,
    getCalls: noBulkRead,
    getCallFacts: noBulkRead,
    getRequestSnapshotData: () =>
      Effect.sync(() => {
        onSnapshot()
        return data
      }),
  }
}

function input(): ScopedViewQueryInputs {
  return { catalogue: emptyCatalogue(), proxyPaths: { paths: [], caseSensitive: false }, scope: { period: 'today' } }
}

describe('Yield calculation', () => {
  it('keeps classification decisions literal and cost/session percentages rounded to tenths', () => {
    const started = session()
    expect(categorizeYieldSession(started, [], true)).toEqual({ category: 'ambiguous', commitCount: 0 })
    expect(categorizeYieldSession(started, [], false)).toEqual({ category: 'abandoned', commitCount: 0 })
    expect(categorizeYieldSession(session({ firstTimestamp: '' }), [], false)).toEqual({
      category: 'abandoned',
      commitCount: 0,
    })

    const payload = calculateYieldPayload(
      [
        {
          commits: [],
          sessions: [started, session({ sessionId: 'session-2', totalCostUSD: 1 })],
          projectNames: ['one', 'two'],
        },
      ],
      { start: new Date(0), end: NOW },
    )
    expect(payload.summary.abandoned).toEqual({ costUSD: 3, sessions: 2, costPercent: 100, sessionPercent: 100 })
    expect(payload.summary.productiveToRevertedCostRatio).toBeNull()
    expect(payload.details.map(detail => detail.project)).toEqual(['one', 'two'])
  })

  it('uses the tightest matching session window and applies the reverted-majority threshold', () => {
    const broad = session({
      sessionId: 'broad',
      firstTimestamp: '2026-10-05T09:30:00.000Z',
      lastTimestamp: '2026-10-05T10:30:00.000Z',
    })
    const tieLaterId = session({ sessionId: 'z-session' })
    const tieEarlierId = session({ sessionId: 'a-session' })
    const commit = { sha: 'commit', timestamp: new Date('2026-10-05T11:15:00.000Z'), inMain: true, wasReverted: false }
    const attributions = attributeYieldCommits([broad, tieLaterId, tieEarlierId], [commit])
    expect(attributions.map(({ commits, lostCandidacy }) => [commits.length, lostCandidacy])).toEqual([
      [0, true],
      [0, true],
      [1, false],
    ])

    expect(
      categorizeYieldSession(
        session(),
        [
          { ...commit, sha: 'one', wasReverted: true },
          { ...commit, sha: 'two', wasReverted: false },
        ],
        false,
      ),
    ).toEqual({ category: 'reverted', commitCount: 2 })
    expect(
      categorizeYieldSession(
        session(),
        [
          { ...commit, sha: 'one', wasReverted: true },
          { ...commit, sha: 'two', wasReverted: false },
          { ...commit, sha: 'three', wasReverted: false },
        ],
        false,
      ),
    ).toEqual({ category: 'productive', commitCount: 3 })
  })
})

describe('queryYieldView', () => {
  it('captures time once, loads one canonical snapshot and validates the output schema', async () => {
    let nowReads = 0
    let snapshotReads = 0
    let nowMillis = NOW.getTime()
    const reports: readonly string[][] = []
    const diagnostics = PricingDiagnostics.of({
      reportUnpricedModels: models => Effect.sync(() => (reports as string[][]).push([...models])),
    })
    const inspection = RepositoryInspection.of({
      resolveIdentity: () =>
        Effect.fail(new RepositoryInspectionError({ operation: 'resolveIdentity', message: 'missing' })),
      getMainBranch: () => Effect.succeed('main'),
      getCommitFacts: () => Effect.succeed([]),
    })
    const payload = await Effect.runPromise(
      queryYieldView(input()).pipe(
        Effect.provideService(
          LedgerQueries,
          LedgerQueries.of(
            queryPort(emptyData(), () => {
              snapshotReads++
              nowMillis += 24 * 60 * 60 * 1000
            }),
          ),
        ),
        Effect.provideService(PricingDiagnostics, diagnostics),
        Effect.provideService(RepositoryInspection, inspection),
        Effect.provideService(
          Clock.Clock,
          testClock(
            () => nowMillis,
            () => nowReads++,
          ),
        ),
      ),
    )
    expect(nowReads).toBe(1)
    expect(snapshotReads).toBe(1)
    expect(payload.period.end).toBe(NOW.toISOString())
    expect(payload.summary.total).toEqual({ costUSD: 0, sessions: 0 })
    expect(
      Schema.decodeUnknownSync((await import('../src/shared/schemas/yield.js')).yieldPayloadSchema)(payload),
    ).toEqual(payload)
    expect(reports).toEqual([[]])
  })

  it('builds a literal Yield summary from one nonempty ledger snapshot', async () => {
    const store = makeStore()
    store.portIn({
      provider: 'opencode',
      envFingerprint: 'yield-query',
      filePath: '/cache/yield-query.jsonl',
      verdict: 'new',
      cachedFile: buildFixtureCachedFile(),
    })
    let nowMillis = NOW.getTime()
    let nowReads = 0
    let snapshotReads = 0
    const reports: string[][] = []
    const inspectionCalls: string[] = []
    const diagnostics = PricingDiagnostics.of({
      reportUnpricedModels: models => Effect.sync(() => reports.push([...models])),
    })
    const inspection = RepositoryInspection.of({
      resolveIdentity: directory =>
        Effect.sync(() => {
          inspectionCalls.push(`identity:${directory}`)
          return { key: 'demo-repository', gitDir: directory }
        }),
      getMainBranch: directory =>
        Effect.sync(() => {
          inspectionCalls.push(`branch:${directory}`)
          return 'main'
        }),
      getCommitFacts: (directory, range) =>
        Effect.sync(() => {
          inspectionCalls.push(`commits:${directory}:${range.end.toISOString()}`)
          return []
        }),
    })
    const payload = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Clock.Clock
        const actual = yield* LedgerQueries
        const queries = LedgerQueries.of({
          ...actual,
          getRequestSnapshotData: () =>
            Effect.sync(() => snapshotReads++).pipe(
              Effect.flatMap(() => actual.getRequestSnapshotData()),
              Effect.tap(() =>
                Effect.sync(() => {
                  nowMillis += 24 * 60 * 60 * 1000
                }),
              ),
            ),
        })
        return yield* queryYieldView({ ...input(), scope: { period: 'lifetime' } }).pipe(
          Effect.provideService(LedgerQueries, queries),
          Effect.provideService(PricingDiagnostics, diagnostics),
          Effect.provideService(RepositoryInspection, inspection),
        )
      }).pipe(
        Effect.provide(store.portsLayer),
        Effect.provideService(
          Clock.Clock,
          testClock(
            () => nowMillis,
            () => nowReads++,
          ),
        ),
      ),
    )

    expect(nowReads).toBe(1)
    expect(snapshotReads).toBe(1)
    expect(inspectionCalls).toEqual([
      'identity:/workspace/demo-project',
      'branch:/workspace/demo-project',
      `commits:/workspace/demo-project:${NOW.toISOString()}`,
    ])
    expect(payload.period.end).toBe(NOW.toISOString())
    expect(payload.summary).toEqual({
      productive: { costUSD: 0, sessions: 0, costPercent: 0, sessionPercent: 0 },
      reverted: { costUSD: 0, sessions: 0, costPercent: 0, sessionPercent: 0 },
      abandoned: { costUSD: 0.42, sessions: 1, costPercent: 100, sessionPercent: 100 },
      ambiguous: { costUSD: 0, sessions: 0, costPercent: 0, sessionPercent: 0 },
      total: { costUSD: 0.42, sessions: 1 },
      productiveToRevertedCostRatio: null,
    })
    expect(payload.details).toEqual([
      { sessionId: 'sess-0', project: 'demo-project', costUSD: 0.42, category: 'abandoned', commitCount: 0 },
    ])
    expect(reports).toHaveLength(1)
  })
})
