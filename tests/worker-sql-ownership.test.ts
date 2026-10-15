import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import * as Sqlite from '@effect/sql-sqlite-node'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DbWorkerContext } from '../src/main/db-worker/context.js'
import type { DbWorkerEvent } from '../src/main/db-worker/protocol.js'
import type { ScanMetadata } from '../src/main/pipeline/scan.js'
import { LedgerConfig, LedgerQueries } from '../src/main/store/ledger-repository.js'
import {
  makeWorkerRuntime,
  openWorkerRuntime,
  type WorkerRuntime,
  type WorkerSqlLayer,
} from '../src/main/worker-runtime.js'
import { withNativeSqliteRuntime } from './fixtures/native-sqlite-runtime.js'

function observedDriver(
  filename: string,
  failure?: Error,
  onFinalize?: () => void,
): {
  layer: WorkerSqlLayer
  counts: { acquisitions: number; finalizers: number }
} {
  const counts = { acquisitions: 0, finalizers: 0 }
  const layer = Layer.effect(
    Sqlite.SqliteClient.SqliteClient,
    Effect.gen(function* () {
      const client = yield* Sqlite.SqliteClient.SqliteClient
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          counts.acquisitions += 1
        }),
        () =>
          Effect.sync(() => {
            counts.finalizers += 1
            onFinalize?.()
          }),
      )
      if (failure) return yield* Effect.die(failure)
      return client
    }),
  ).pipe(Layer.provideMerge(Sqlite.SqliteClient.layer({ filename })))
  return { layer, counts }
}

function recordRuntime(runtimes: WorkerRuntime[]): typeof makeWorkerRuntime {
  return (dbPath, layer) => {
    const runtime = makeWorkerRuntime(dbPath, layer)
    runtimes.push(runtime)
    return runtime
  }
}

describe('db-worker SQL ownership', () => {
  const directories: string[] = []

  function databasePath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'watchtower-worker-sql-owner-'))
    directories.push(dir)
    return join(dir, 'ledger.db')
  }

  function removeFixture(directory: string): void {
    const target = resolve(directory)
    assert.equal(dirname(target), resolve(tmpdir()))
    assert.ok(basename(target).startsWith('watchtower-worker-sql-owner-'))
    rmSync(target, { recursive: true, force: true })
  }

  afterEach(() => {
    vi.restoreAllMocks()
    while (directories.length > 0) {
      const directory = directories.pop()
      if (directory) removeFixture(directory)
    }
  })

  it('constructs one runtime and closes the real driver once after the worker lifetime', async () => {
    const path = join(dirname(databasePath()), 'nested', 'db', 'ledger.db')
    const driver = observedDriver(path)
    const runtimes: WorkerRuntime[] = []
    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    const prepare = vi.spyOn(DatabaseSync.prototype, 'prepare')
    const runtime = openWorkerRuntime(path, undefined, undefined, {
      sqliteLayer: driver.layer,
      makeRuntime: recordRuntime(runtimes),
    })
    const fixtureRuntime = runtimes.at(-1)
    if (!fixtureRuntime) throw new Error('runtime factory was not called')
    try {
      expect(runtimes).toHaveLength(1)
      expect(driver.counts).toEqual({ acquisitions: 1, finalizers: 0 })
      expect(close).not.toHaveBeenCalled()
      await expect(runtime.runPromise(Effect.flatMap(LedgerQueries, queries => queries.getSources()))).resolves.toEqual(
        [],
      )
      expect(
        prepare.mock.calls.filter(([query]) => query.includes('COALESCE(MAX(migration_id), 0) AS version')),
      ).toHaveLength(1)
      expect(runtime.runSync(Effect.flatMap(LedgerConfig, config => config.getRefreshCadence()))).toBe('1m')
      expect(close).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
      runtimes.splice(runtimes.indexOf(fixtureRuntime), 1)
    }
    expect(driver.counts).toEqual({ acquisitions: 1, finalizers: 1 })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('finishes manual scan events and owner cleanup before releasing the real SQL client', async () => {
    const path = databasePath()
    const order: string[] = []
    const activeOwner = { read: () => undefined as unknown }
    const driver = observedDriver(path, undefined, () => {
      expect(activeOwner.read()).toBeNull()
      order.push('sql-release')
    })
    const runtimes: WorkerRuntime[] = []
    const runtime = openWorkerRuntime(path, undefined, undefined, {
      sqliteLayer: driver.layer,
      makeRuntime: recordRuntime(runtimes),
    })
    let resolveScan!: (metadata: ScanMetadata) => void
    let scanResolved = false
    const metadata: ScanMetadata = {
      scanId: 'manual-shutdown-barrier',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      portedFiles: 0,
      unchangedFiles: 0,
      failedFiles: 0,
      perProvider: [],
      aborted: false,
    }
    const scanResult = new Promise<ScanMetadata>(resolve => {
      resolveScan = resolve
    })
    const finishScan = (): void => {
      if (scanResolved) return
      scanResolved = true
      resolveScan(metadata)
    }
    const events: DbWorkerEvent[] = []
    const worker = new DbWorkerContext(
      { dbPath: path, dataDir: dirname(path), cacheDir: join(dirname(path), 'cache') },
      event => {
        events.push(event)
        if (event.event === 'oplog' && event.logEvent === 'scan.finish') order.push('scan-finish')
      },
      { runtime },
    )
    activeOwner.read = () => (worker as unknown as { activeScan: unknown }).activeScan
    vi.spyOn(
      worker as unknown as { performScan: (...args: never[]) => Effect.Effect<ScanMetadata, unknown> },
      'performScan',
    ).mockReturnValue(Effect.tryPromise({ try: () => scanResult, catch: cause => cause }))

    try {
      const request = worker.dispatch('scan:start', [])
      await vi.waitFor(() => expect((worker as unknown as { activeScan: unknown }).activeScan).not.toBeNull())
      const closing = worker.close()
      await Promise.resolve()
      expect(driver.counts.finalizers).toBe(0)

      finishScan()
      await expect(request).resolves.toEqual({ ok: true })
      await closing

      expect(order).toEqual(['scan-finish', 'sql-release'])
      expect(events).toContainEqual(expect.objectContaining({ event: 'store:changed' }))
    } finally {
      finishScan()
      await worker.close()
      await runtime.dispose()
      const fixtureRuntime = runtimes.at(-1)
      if (fixtureRuntime) runtimes.splice(runtimes.indexOf(fixtureRuntime), 1)
    }
  })

  it('closes the real driver when a future schema version rejects boot', async () => {
    const path = databasePath()
    await withNativeSqliteRuntime(path, runtime => {
      const sql = runtime.runSync(SqlClient.SqlClient)
      runtime.runSync(
        Effect.gen(function* () {
          yield* sql.unsafe(
            'CREATE TABLE watchtower_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)',
          )
          yield* sql.unsafe(
            "INSERT INTO watchtower_sql_migrations (migration_id, name, created_at) VALUES (99, 'future', 'now')",
          )
        }),
      )
    })
    const driver = observedDriver(path)
    const runtimes: WorkerRuntime[] = []
    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    expect(() =>
      openWorkerRuntime(path, undefined, undefined, {
        sqliteLayer: driver.layer,
        makeRuntime: recordRuntime(runtimes),
      }),
    ).toThrow(/newer than this application supports/)
    expect(runtimes).toHaveLength(1)
    expect(driver.counts).toEqual({ acquisitions: 1, finalizers: 1 })
    expect(close).toHaveBeenCalledTimes(1)
    const failedRuntime = runtimes[0]
    expect(failedRuntime).toBeDefined()
    expect(() => failedRuntime?.runSync(Effect.void)).toThrow(/ManagedRuntime disposed/)

    await withNativeSqliteRuntime(path, runtime => {
      const sql = runtime.runSync(SqlClient.SqlClient)
      expect(runtime.runSync(sql.unsafe('SELECT migration_id FROM watchtower_sql_migrations'))[0]).toEqual({
        migration_id: 99,
      })
    })
  })

  it('closes the real driver and runtime when graph construction fails after acquisition', () => {
    const path = databasePath()
    const driver = observedDriver(path, new Error('controlled layer-build failure'))
    const runtimes: WorkerRuntime[] = []
    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    expect(() =>
      openWorkerRuntime(path, undefined, undefined, {
        sqliteLayer: driver.layer,
        makeRuntime: recordRuntime(runtimes),
      }),
    ).toThrow(/controlled layer-build failure/)
    expect(runtimes).toHaveLength(1)
    expect(driver.counts).toEqual({ acquisitions: 1, finalizers: 1 })
    expect(close).toHaveBeenCalledTimes(1)
    const failedRuntime = runtimes[0]
    expect(failedRuntime).toBeDefined()
    expect(() => failedRuntime?.runSync(Effect.void)).toThrow(/ManagedRuntime disposed/)
  })
})
