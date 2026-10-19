import { DatabaseSync } from 'node:sqlite'

import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Schema from 'effect/Schema'
import * as SqlError from 'effect/sql/SqlError'
import * as Tracer from 'effect/Tracer'
import { describe, expect, it } from 'vitest'

import { capturePricingCatalogue } from '../src/main/pipeline/pricing-calculation.js'
import { LedgerConfig, LedgerIngest, LedgerQueries } from '../src/main/store/ledger-ports.js'
import { loadLedgerQuerySnapshotEffect } from '../src/main/store/ledger-query-snapshot.js'
import { buildFixtureCachedFile, FIXTURE_SOURCE_PATH } from './fixtures/cached-file.js'
import { openLedgerFixture } from './fixtures/ledger-runtime.js'

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

describe('Effect query snapshot loader', () => {
  it('reads one consistent SQLite snapshot and rereads fresh aliases and overrides', async () => {
    const { runtime } = openLedgerFixture()
    runtime.runSync(
      Effect.flatMap(LedgerIngest, ingest =>
        ingest.portIn({
          provider: 'opencode',
          envFingerprint: 'query-snapshot',
          filePath: FIXTURE_SOURCE_PATH,
          verdict: 'new',
          cachedFile: buildFixtureCachedFile(),
        }),
      ),
    )
    runtime.runSync(Effect.flatMap(LedgerConfig, config => config.setModelAlias('demo-model', 'first-effective-model')))
    runtime.runSync(
      Effect.flatMap(LedgerConfig, config =>
        config.setPriceOverride('first-effective-model', {
          inputPricePerMillion: 3,
          outputPricePerMillion: 12,
        }),
      ),
    )

    let snapshotReads = 0
    const catalogue = testCatalogue()
    let proxyPaths = { paths: ['/captured/path'], caseSensitive: false }
    const load = () =>
      Effect.gen(function* () {
        const actual = yield* LedgerQueries
        const queries = LedgerQueries.of({
          hasSources: actual.hasSources,
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
      })

    const first = await runtime.runPromise(load())
    expect(snapshotReads).toBe(1)
    expect(first.sources).toHaveLength(1)
    expect(first.sessions).toHaveLength(1)
    expect(first.turns).toHaveLength(1)
    expect(first.calls.length).toBeGreaterThan(0)
    expect(first.aliases).toEqual([{ model: 'demo-model', aliasOf: 'first-effective-model' }])
    expect(first.overrides).toEqual([
      {
        model: 'first-effective-model',
        inputPricePerMillion: 3,
        outputPricePerMillion: 12,
      },
    ])
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
    const second = await runtime.runPromise(load())
    expect(second.proxyPaths).toEqual({ paths: ['/next/request'], caseSensitive: true })
    expect(first.proxyPaths).toEqual({ paths: ['/captured/path'], caseSensitive: false })
    expect(second.aliases).toEqual(first.aliases)
    expect(second.overrides).toEqual(first.overrides)

    runtime.runSync(
      Effect.flatMap(LedgerConfig, config => config.setModelAlias('demo-model', 'second-effective-model')),
    )
    runtime.runSync(
      Effect.flatMap(LedgerConfig, config =>
        config.setPriceOverride('second-effective-model', {
          inputPricePerMillion: 7,
          outputPricePerMillion: 21,
        }),
      ),
    )

    const third = await runtime.runPromise(load())
    expect(snapshotReads).toBe(3)
    expect(third.pricing.resolveAlias('demo-model')).toBe('second-effective-model')
    expect(third.pricing.findOverride('second-effective-model')).toEqual({
      inputPricePerMillion: 7,
      outputPricePerMillion: 21,
    })
    expect(third.aliases).toEqual([{ model: 'demo-model', aliasOf: 'second-effective-model' }])
    expect(third.overrides).toEqual([
      {
        model: 'first-effective-model',
        inputPricePerMillion: 3,
        outputPricePerMillion: 12,
      },
      {
        model: 'second-effective-model',
        inputPricePerMillion: 7,
        outputPricePerMillion: 21,
      },
    ])
    expect(first.aliases).toEqual([{ model: 'demo-model', aliasOf: 'first-effective-model' }])
    expect(first.overrides).toEqual([
      {
        model: 'first-effective-model',
        inputPricePerMillion: 3,
        outputPricePerMillion: 12,
      },
    ])
    expect(first.pricing.resolveAlias('demo-model')).toBe('first-effective-model')
    expect(first.pricing.findOverride('first-effective-model')).toEqual({
      inputPricePerMillion: 3,
      outputPricePerMillion: 12,
    })
  })

  it('commits the materialized read before a row schema failure', async () => {
    const { dbPath, runtime } = openLedgerFixture()
    runtime.runSync(
      Effect.flatMap(LedgerIngest, ingest =>
        ingest.portIn({
          provider: 'opencode',
          envFingerprint: 'query-snapshot-schema-error',
          filePath: FIXTURE_SOURCE_PATH,
          verdict: 'new',
          cachedFile: buildFixtureCachedFile(),
        }),
      ),
    )

    const writer = new DatabaseSync(dbPath)
    try {
      writer.exec("UPDATE ledger_call SET speed = 'hyperdrive' WHERE call_index = 0")
    } finally {
      writer.close()
    }

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

    const result = await runtime.runPromise(
      Effect.exit(Effect.flatMap(LedgerQueries, queries => queries.getRequestSnapshotData())).pipe(
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
  })

  it('keeps SQL read failures typed instead of turning them into defects', async () => {
    const { dbPath, runtime } = openLedgerFixture()

    const writer = new DatabaseSync(dbPath)
    try {
      writer.exec('DROP TABLE ledger_turn')
    } finally {
      writer.close()
    }

    const result = await runtime.runPromise(
      Effect.exit(Effect.flatMap(LedgerQueries, queries => queries.getRequestSnapshotData())),
    )
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      const failure = result.cause.reasons.find(Cause.isFailReason)
      expect(failure).toBeDefined()
      if (failure) expect(SqlError.isSqlError(failure.error)).toBe(true)
    }
  })
})
