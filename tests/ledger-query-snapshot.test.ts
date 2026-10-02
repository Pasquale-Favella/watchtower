import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import * as Tracer from 'effect/Tracer'
import * as SqlError from 'effect/unstable/sql/SqlError'
import { afterEach, describe, expect, it } from 'vitest'

import { capturePricingCatalogue } from '../src/main/pipeline/pricing-calculation.js'
import { LedgerStore } from '../src/main/store/ledger.js'
import { LedgerQueries } from '../src/main/store/ledger-ports.js'
import { loadLedgerQuerySnapshotEffect } from '../src/main/store/ledger-query-snapshot.js'
import { buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'

const tempDirs: string[] = []

function makeStore(): LedgerStore {
  const dir = mkdtempSync(join(tmpdir(), 'watchtower-query-snapshot-'))
  tempDirs.push(dir)
  return new LedgerStore(join(dir, 'ledger.db'))
}

function testCatalogue() {
  return capturePricingCatalogue({
    prices: new Map(),
    overrides: new Map(),
    builtinAliases: {},
    userAliases: {},
    tiers: [],
    routedSegments: new Set(),
  })
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('Effect query snapshot loader', () => {
  it('reads one consistent SQLite snapshot and rereads fresh aliases and overrides', async () => {
    const store = makeStore()
    try {
      store.portIn({
        provider: 'opencode',
        envFingerprint: 'query-snapshot',
        filePath: FIXTURE_SOURCE_PATH,
        verdict: 'new',
        cachedFile: buildFixtureCachedFile(),
      })
      store.setModelAlias('demo-model', 'first-effective-model')
      store.setPriceOverride('first-effective-model', {
        inputPricePerMillion: 3,
        outputPricePerMillion: 12,
      })

      let snapshotReads = 0
      const catalogue = testCatalogue()
      let proxyPaths = { paths: ['/captured/path'], caseSensitive: false }
      const load = () =>
        Effect.gen(function* () {
          const actual = yield* LedgerQueries
          const queries = LedgerQueries.of({
            getSources: actual.getSources,
            getSessions: actual.getSessions,
            getTurns: actual.getTurns,
            getCalls: actual.getCalls,
            getCallFacts: actual.getCallFacts,
            getRequestSnapshotData: () =>
              Effect.sync(() => snapshotReads++).pipe(Effect.flatMap(() => actual.getRequestSnapshotData())),
          })
          return yield* loadLedgerQuerySnapshotEffect({ catalogue, proxyPaths }).pipe(
            Effect.provideService(LedgerQueries, queries),
          )
        }).pipe(Effect.provide(store.portsLayer))

      const first = await Effect.runPromise(load())
      expect(snapshotReads).toBe(1)
      expect(first.sources).toHaveLength(1)
      expect(first.sessions).toHaveLength(1)
      expect(first.turns).toHaveLength(1)
      expect(first.calls.length).toBeGreaterThan(0)
      expect(first.catalogue).toBe(catalogue)
      expect(first.proxyPaths).toEqual({ paths: ['/captured/path'], caseSensitive: false })
      expect(Object.isFrozen(first.proxyPaths)).toBe(true)
      expect(Object.isFrozen(first.proxyPaths.paths)).toBe(true)
      expect(first.pricing.resolveAlias('demo-model')).toBe('first-effective-model')
      expect(first.pricing.findOverride('first-effective-model')).toEqual({
        inputPricePerMillion: 3,
        outputPricePerMillion: 12,
      })

      proxyPaths = { paths: ['/next/request'], caseSensitive: true }
      const second = await Effect.runPromise(load())
      expect(second.proxyPaths).toEqual({ paths: ['/next/request'], caseSensitive: true })
      expect(first.proxyPaths).toEqual({ paths: ['/captured/path'], caseSensitive: false })

      store.setModelAlias('demo-model', 'second-effective-model')
      store.setPriceOverride('second-effective-model', {
        inputPricePerMillion: 7,
        outputPricePerMillion: 21,
      })

      const third = await Effect.runPromise(load())
      expect(snapshotReads).toBe(3)
      expect(third.pricing.resolveAlias('demo-model')).toBe('second-effective-model')
      expect(third.pricing.findOverride('second-effective-model')).toEqual({
        inputPricePerMillion: 7,
        outputPricePerMillion: 21,
      })
      expect(first.pricing.resolveAlias('demo-model')).toBe('first-effective-model')
      expect(first.pricing.findOverride('first-effective-model')).toEqual({
        inputPricePerMillion: 3,
        outputPricePerMillion: 12,
      })
    } finally {
      store.close()
    }
  })

  it('commits the materialized read before a row schema failure', async () => {
    const store = makeStore()
    store.portIn({
      provider: 'opencode',
      envFingerprint: 'query-snapshot-schema-error',
      filePath: FIXTURE_SOURCE_PATH,
      verdict: 'new',
      cachedFile: buildFixtureCachedFile(),
    })
    const dbPath = store.dbPath
    store.close()

    const writer = new DatabaseSync(dbPath)
    try {
      writer.exec("UPDATE ledger_call SET speed = 'hyperdrive' WHERE call_index = 0")
    } finally {
      writer.close()
    }

    const reopened = new LedgerStore(dbPath)
    try {
      const transactionEnds: Array<{ name: string; exit: Exit.Exit<unknown, unknown> }> = []
      class RecordingSpan extends Tracer.NativeSpan {
        override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
          transactionEnds.push({ name: this.name, exit })
          super.end(endTime, exit)
        }
      }
      const tracer = Tracer.make({
        span: options => new RecordingSpan(options),
      })

      const result = await Effect.runPromise(
        Effect.exit(Effect.flatMap(LedgerQueries, queries => queries.getRequestSnapshotData())).pipe(
          Effect.provide(reopened.portsLayer),
          Effect.provideService(Tracer.Tracer, tracer),
        ),
      )

      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const failure = result.cause.reasons.find(Cause.isFailReason)
        expect(failure).toBeDefined()
        if (failure) expect(Schema.isSchemaError(failure.error)).toBe(true)
      }
      const transaction = transactionEnds.find(span => span.name === 'sql.transaction')
      expect(transaction).toBeDefined()
      expect(transaction && Exit.isSuccess(transaction.exit)).toBe(true)
    } finally {
      reopened.close()
    }
  })

  it('keeps SQL read failures typed instead of turning them into defects', async () => {
    const store = makeStore()
    const dbPath = store.dbPath
    store.close()

    const writer = new DatabaseSync(dbPath)
    try {
      writer.exec('DROP TABLE ledger_turn')
    } finally {
      writer.close()
    }

    const reopened = new LedgerStore(dbPath)
    try {
      const result = await Effect.runPromise(
        Effect.exit(Effect.flatMap(LedgerQueries, queries => queries.getRequestSnapshotData())).pipe(
          Effect.provide(reopened.portsLayer),
        ),
      )
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const failure = result.cause.reasons.find(Cause.isFailReason)
        expect(failure).toBeDefined()
        if (failure) expect(SqlError.isSqlError(failure.error)).toBe(true)
      }
    } finally {
      reopened.close()
    }
  })
})
