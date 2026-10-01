import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import * as Sqlite from '@effect/sql-sqlite-node'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LedgerConfig } from '../src/main/store/ledger-repository.js'
import { NodeSqliteDatabase } from '../src/main/store/node-sqlite-client.js'
import {
  makeWorkerRuntime,
  openWorkerOwner,
  type WorkerRuntime,
  type WorkerSqlLayer,
} from '../src/main/worker-runtime.js'

function observedDriver(
  filename: string,
  failure?: Error,
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

  afterEach(() => {
    vi.restoreAllMocks()
    while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true })
  })

  it('constructs one runtime and closes the real driver once after the worker lifetime', () => {
    const path = databasePath()
    const driver = observedDriver(path)
    const runtimes: WorkerRuntime[] = []
    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    const owner = openWorkerOwner(path, undefined, undefined, {
      sqliteLayer: driver.layer,
      makeRuntime: recordRuntime(runtimes),
    })
    try {
      expect(runtimes).toHaveLength(1)
      expect(driver.counts).toEqual({ acquisitions: 1, finalizers: 0 })
      expect(close).not.toHaveBeenCalled()
      expect(owner.ledger.getTableNames()).toContain('ledger_source')
      // The facade borrows the root; closing it cannot retire the client.
      owner.ledger.close()
      expect(owner.runtime.runSync(Effect.flatMap(LedgerConfig, config => config.getRefreshCadence()))).toBe('1m')
      expect(close).not.toHaveBeenCalled()
    } finally {
      Effect.runSync(owner.runtime.disposeEffect)
    }
    expect(driver.counts).toEqual({ acquisitions: 1, finalizers: 1 })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes the real driver when a future schema version rejects boot', () => {
    const path = databasePath()
    const setup = new NodeSqliteDatabase(path)
    try {
      setup.exec(
        "CREATE TABLE watchtower_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL); INSERT INTO watchtower_sql_migrations (migration_id, name, created_at) VALUES (99, 'future', 'now')",
      )
    } finally {
      setup.close()
    }
    const driver = observedDriver(path)
    const runtimes: WorkerRuntime[] = []
    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    expect(() =>
      openWorkerOwner(path, undefined, undefined, {
        sqliteLayer: driver.layer,
        makeRuntime: recordRuntime(runtimes),
      }),
    ).toThrow(/newer than this application supports/)
    expect(runtimes).toHaveLength(1)
    expect(driver.counts).toEqual({ acquisitions: 1, finalizers: 1 })
    expect(close).toHaveBeenCalledTimes(1)
    expect(() => runtimes[0].runSync(Effect.void)).toThrow(/ManagedRuntime disposed/)

    const reopened = new NodeSqliteDatabase(path)
    try {
      expect(reopened.prepare('SELECT migration_id FROM watchtower_sql_migrations').get()).toEqual({ migration_id: 99 })
    } finally {
      reopened.close()
    }
  })

  it('closes the real driver and runtime when graph construction fails after acquisition', () => {
    const path = databasePath()
    const driver = observedDriver(path, new Error('controlled layer-build failure'))
    const runtimes: WorkerRuntime[] = []
    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    expect(() =>
      openWorkerOwner(path, undefined, undefined, {
        sqliteLayer: driver.layer,
        makeRuntime: recordRuntime(runtimes),
      }),
    ).toThrow(/controlled layer-build failure/)
    expect(runtimes).toHaveLength(1)
    expect(driver.counts).toEqual({ acquisitions: 1, finalizers: 1 })
    expect(close).toHaveBeenCalledTimes(1)
    expect(() => runtimes[0].runSync(Effect.void)).toThrow(/ManagedRuntime disposed/)
  })
})
