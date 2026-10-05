import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as TestClock from 'effect/testing/TestClock'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AssistantSetup } from '../src/main/application/assistant-setup.js'
import { PricingDiagnostics } from '../src/main/application/pricing-diagnostics.js'
import { querySkillsView } from '../src/main/application/skills-query.js'
import type { ScopedViewQueryInputs } from '../src/main/application/view-queries.js'
import { overviewDateRange } from '../src/main/overview-scope.js'
import { capturePricingCatalogue } from '../src/main/pipeline/pricing-calculation.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import {
  LedgerConfig,
  type LedgerConfigPort,
  LedgerQueries,
  type LedgerQueriesPort,
  type LedgerRequestSnapshotData,
} from '../src/main/store/ledger-ports.js'
import { buildFixtureCachedCall, buildFixtureCachedFile, buildFixtureCachedTurn } from './fixtures/cached-file.js'

const directories: string[] = []
const root = process.platform === 'win32' ? 'C:/workspace' : '/workspace'
const inputs: ScopedViewQueryInputs = {
  scope: { period: 'lifetime' },
  catalogue: capturePricingCatalogue({
    prices: new Map(),
    overrides: new Map(),
    builtinAliases: {},
    userAliases: {},
    tiers: [],
    routedSegments: new Set(),
  }),
  proxyPaths: { paths: [], caseSensitive: false },
}

function makeStore(): LedgerStore {
  const directory = mkdtempSync(join(tmpdir(), 'watchtower-skills-query-'))
  directories.push(directory)
  return new LedgerStore(join(directory, 'ledger.db'))
}

function portSkill(store: LedgerStore, sessionId: string, date = '2026-07-13', skills = ['data-fetch']): void {
  const timestamp = new Date(`${date}T12:00:00Z`).toISOString()
  const call = {
    ...buildFixtureCachedCall(0),
    provider: 'opencode',
    model: 'demo-model',
    costUSD: 0.5,
    timestamp,
    skills,
    bashCommands: [],
    tools: ['Edit'],
  }
  const turn = buildFixtureCachedTurn(0, 'task', { sessionId, timestamp, calls: [call] })
  store.portIn({
    provider: 'opencode',
    envFingerprint: 'skills-query',
    filePath: `/cache/${sessionId}.jsonl`,
    verdict: 'new',
    cachedFile: buildFixtureCachedFile({ canonicalProjectName: 'src', canonicalCwd: `${root}/project`, turns: [turn] }),
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('querySkillsView', () => {
  it('builds a literal payload with one snapshot, one dismissal read and one inventory call', async () => {
    const store = makeStore()
    try {
      portSkill(store, 'session-a')
      const snapshotReads = vi.fn()
      const individualReads = vi.fn()
      const dismissalReads = vi.fn()
      const inventoryCalls = vi.fn()
      const reports: string[][] = []
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(new Date('2026-07-14T12:00:00Z').getTime())
          const actualQueries = yield* LedgerQueries
          const actualConfig = yield* LedgerConfig
          const rejectIndividualRead = () =>
            Effect.sync(() => {
              individualReads()
              throw new Error('unexpected individual ledger read')
            })
          const queries = LedgerQueries.of({
            ...actualQueries,
            getSources: rejectIndividualRead,
            getSessions: rejectIndividualRead,
            getTurns: rejectIndividualRead,
            getCalls: rejectIndividualRead,
            getCallFacts: rejectIndividualRead,
            getRequestSnapshotData: () =>
              Effect.sync(() => snapshotReads()).pipe(Effect.andThen(actualQueries.getRequestSnapshotData())),
          })
          const config = LedgerConfig.of({
            ...actualConfig,
            getSkillDismissals: () =>
              Effect.sync(() => dismissalReads()).pipe(
                Effect.andThen(
                  Effect.succeed([
                    { source: 'tool' as const, name: 'ignored', reason: 'not a skill', created: '2026-01-01' },
                  ]),
                ),
              ),
          })
          const setup = AssistantSetup.of({
            getSkillInventory: (directories, homeDir) =>
              Effect.sync(() => {
                inventoryCalls(directories, homeDir)
                return [{ name: 'debugger', root: '/home/test/.claude/skills' }]
              }),
            getOptimizeSetup: () => Effect.die('not used'),
          })
          return yield* querySkillsView({ ...inputs, homeDir: '/home/test' }).pipe(
            Effect.provideService(LedgerQueries, queries),
            Effect.provideService(LedgerConfig, config),
            Effect.provideService(AssistantSetup, setup),
            Effect.provideService(
              PricingDiagnostics,
              PricingDiagnostics.of({
                reportUnpricedModels: models => Effect.sync(() => reports.push([...models])),
              }),
            ),
          )
        }).pipe(Effect.provide(store.portsLayer), Effect.provide(TestClock.layer())),
      )

      expect(result).toEqual({
        period: {
          start: overviewDateRange({ period: 'lifetime' }, new Date('2026-07-14T12:00:00Z')).start.toISOString(),
          end: overviewDateRange({ period: 'lifetime' }, new Date('2026-07-14T12:00:00Z')).end.toISOString(),
        },
        summary: {
          sessions: 1,
          calls: 1,
          skillEvents: 2,
          bashEvents: 0,
          toolEvents: 0,
          drafts: 0,
          opportunities: 1,
          ghosts: 1,
        },
        drafts: [],
        opportunities: [
          {
            name: 'data-fetch',
            source: 'skill',
            frequency: 2,
            spreadSessions: 1,
            spreadProjects: 1,
            costUSD: 1,
            turns: 1,
            latest: '2026-07-13T12:00:00.000Z',
            sample: 'data-fetch',
            sourceSessions: [{ sessionId: 'session-a', project: 'src', date: '2026-07-13', turns: 2, costUSD: 1 }],
          },
        ],
        ghosts: [{ name: 'debugger', root: '/home/test/.claude/skills' }],
      })
      expect(snapshotReads).toHaveBeenCalledTimes(1)
      expect(individualReads).not.toHaveBeenCalled()
      expect(dismissalReads).toHaveBeenCalledTimes(1)
      expect(inventoryCalls).toHaveBeenCalledTimes(1)
      expect(inventoryCalls).toHaveBeenCalledWith([], '/home/test')
      expect(reports).toEqual([[]])
    } finally {
      store.close()
    }
  })

  it('captures time before the deferred snapshot and applies provider and custom date bounds', async () => {
    const store = makeStore()
    try {
      portSkill(store, 'in', '2025-12-31')
      portSkill(store, 'out', '2026-01-01')
      const snapshotReads = vi.fn()
      const inventoryCalls: string[][] = []
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(new Date('2026-01-01T23:59:59Z').getTime())
          const actual = yield* LedgerQueries
          const actualConfig = yield* LedgerConfig
          const queries = LedgerQueries.of({
            ...actual,
            getRequestSnapshotData: () =>
              Effect.gen(function* () {
                snapshotReads()
                yield* TestClock.adjust(2_000)
                return yield* actual.getRequestSnapshotData()
              }),
          })
          const setup = AssistantSetup.of({
            getSkillInventory: directories =>
              Effect.sync(() => {
                inventoryCalls.push([...directories])
                return []
              }),
            getOptimizeSetup: () => Effect.die('not used'),
          })
          return yield* querySkillsView({
            ...inputs,
            scope: { period: 'lifetime', provider: 'opencode', range: { since: '2025-12-31', until: '2025-12-31' } },
          }).pipe(
            Effect.provideService(LedgerQueries, queries),
            Effect.provideService(AssistantSetup, setup),
            Effect.provideService(
              LedgerConfig,
              LedgerConfig.of({
                ...actualConfig,
                getSkillDismissals: () => Effect.succeed([]),
              }),
            ),
            Effect.provideService(
              PricingDiagnostics,
              PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void }),
            ),
          )
        }).pipe(Effect.provide(store.portsLayer), Effect.provide(TestClock.layer())),
      )
      expect(snapshotReads).toHaveBeenCalledTimes(1)
      const expectedRange = overviewDateRange(
        { period: 'lifetime', provider: 'opencode', range: { since: '2025-12-31', until: '2025-12-31' } },
        new Date('2026-01-01T23:59:59Z'),
      )
      expect(result.period).toEqual({ start: expectedRange.start.toISOString(), end: expectedRange.end.toISOString() })
      expect(result.summary.sessions).toBe(1)
      expect(result.summary.calls).toBe(1)
      expect(inventoryCalls).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('uses the clock captured before the snapshot crosses local midnight', async () => {
    const store = makeStore()
    try {
      portSkill(store, 'midnight', '2026-07-13')
      const beforeMidnight = new Date(2026, 6, 13, 23, 59, 59, 500)
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          yield* TestClock.setTime(beforeMidnight.getTime())
          const actualQueries = yield* LedgerQueries
          const actualConfig = yield* LedgerConfig
          const queries = LedgerQueries.of({
            ...actualQueries,
            getRequestSnapshotData: () =>
              Effect.gen(function* () {
                yield* TestClock.adjust(1_000)
                return yield* actualQueries.getRequestSnapshotData()
              }),
          })
          return yield* querySkillsView({ ...inputs, scope: { period: 'today' } }).pipe(
            Effect.provideService(LedgerQueries, queries),
            Effect.provideService(
              LedgerConfig,
              LedgerConfig.of({ ...actualConfig, getSkillDismissals: () => Effect.succeed([]) }),
            ),
            Effect.provideService(
              AssistantSetup,
              AssistantSetup.of({
                getSkillInventory: () => Effect.succeed([]),
                getOptimizeSetup: () => Effect.die('not used'),
              }),
            ),
            Effect.provideService(
              PricingDiagnostics,
              PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void }),
            ),
          )
        }).pipe(Effect.provide(store.portsLayer), Effect.provide(TestClock.layer())),
      )
      const range = overviewDateRange({ period: 'today' }, beforeMidnight)
      expect(result.period).toEqual({ start: range.start.toISOString(), end: range.end.toISOString() })
      expect(result.summary.sessions).toBe(1)
      expect(result.summary.calls).toBe(1)
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
      const empty: LedgerRequestSnapshotData = {
        sources: [],
        sessions: [],
        turns: [],
        calls: [],
        aliases: [],
        overrides: [],
      }
      const baseConfig: LedgerConfigPort = {
        getModelAliases: () => Effect.succeed([]),
        setModelAlias: () => Effect.void,
        removeModelAlias: () => Effect.void,
        getPriceOverrides: () => Effect.succeed([]),
        setPriceOverride: () => Effect.void,
        removePriceOverride: () => Effect.void,
        getCurrencyRate: () => Effect.succeed(null),
        setCurrencyRate: () => Effect.void,
        getDisplayCurrency: () => Effect.succeed('USD'),
        setDisplayCurrency: () => Effect.void,
        getRefreshCadence: () => Effect.succeed('manual'),
        setRefreshCadence: () => Effect.void,
        getLedgerMcpStartupMode: () => Effect.succeed('on-demand'),
        setLedgerMcpStartupMode: () => Effect.void,
        getSkillDismissals: () => Effect.succeed([]),
        dismissSkill: () => Effect.void,
      }
      const setup = AssistantSetup.of({
        getSkillInventory: () => Effect.succeed([]),
        getOptimizeSetup: () => Effect.die('not used'),
      })
      const run = (queries: LedgerQueriesPort) =>
        querySkillsView(inputs).pipe(
          Effect.provideService(LedgerQueries, LedgerQueries.of(queries)),
          Effect.provideService(LedgerConfig, LedgerConfig.of(baseConfig)),
          Effect.provideService(AssistantSetup, setup),
          Effect.provideService(PricingDiagnostics, PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void })),
          Effect.provide(store.portsLayer),
          Effect.provide(TestClock.layer()),
        )
      const sqlFailure = new SqlError.SqlError({
        reason: new SqlError.SqlSyntaxError({ cause: new Error('controlled failure'), message: 'controlled failure' }),
      })
      await expect(
        Effect.runPromise(run({ ...actual, getRequestSnapshotData: () => Effect.fail(sqlFailure) })),
      ).rejects.toMatchObject({ _tag: 'SqlError' })
      const schemaFailure = {
        ...actual,
        getRequestSnapshotData: () => Schema.decodeUnknownEffect(Schema.Number)('invalid').pipe(Effect.as(empty)),
      }
      await expect(Effect.runPromise(run(schemaFailure))).rejects.toMatchObject({ _tag: 'SchemaError' })
    } finally {
      store.close()
    }
  })
})
