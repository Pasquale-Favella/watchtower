import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { describe, expect, it, vi } from 'vitest'

import { initializeLedger } from '../src/main/store/ledger-initialization.js'
import { makeWorkerRuntime, openWorkerRuntime } from '../src/main/worker-runtime.js'

describe('ledger initialization', () => {
  it('applies the shared schema migration once and accepts a repeated initialization', async () => {
    const runtime = makeWorkerRuntime(':memory:')
    try {
      runtime.runSync(initializeLedger)
      runtime.runSync(initializeLedger)
      const sql = runtime.runSync(SqlClient.SqlClient)

      expect(runtime.runSync(sql.unsafe('SELECT migration_id, name FROM watchtower_sql_migrations'))).toEqual([
        { migration_id: 1, name: 'initial_ledger_schema' },
      ])
      expect(
        runtime.runSync(sql.unsafe("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_source'")),
      ).toEqual([{ name: 'ledger_source' }])
      expect(
        runtime.runSync(
          sql.unsafe("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_mcp_config'"),
        ),
      ).toEqual([{ name: 'ledger_mcp_config' }])
    } finally {
      await runtime.dispose()
    }
  })

  it('rejects a future schema after the migrator leaves its history intact', async () => {
    const runtime = makeWorkerRuntime(':memory:')
    try {
      const sql = runtime.runSync(SqlClient.SqlClient)
      runtime.runSync(
        sql.unsafe(
          'CREATE TABLE watchtower_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL)',
        ),
      )
      runtime.runSync(
        sql.unsafe(
          "INSERT INTO watchtower_sql_migrations (migration_id, name, created_at) VALUES (99, 'future', 'now')",
        ),
      )

      expect(() => runtime.runSync(initializeLedger)).toThrow(/newer than this application supports/)
      expect(runtime.runSync(sql.unsafe('SELECT migration_id FROM watchtower_sql_migrations'))).toEqual([
        { migration_id: 99 },
      ])
    } finally {
      await runtime.dispose()
    }
  })

  it('closes the worker connection when initialization rejects a future schema', () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-ledger-init-'))
    const dbPath = join(directory, 'nested', 'ledger.db')
    mkdirSync(dirname(dbPath), { recursive: true })
    const setup = new DatabaseSync(dbPath)
    setup.exec(
      "CREATE TABLE watchtower_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL); INSERT INTO watchtower_sql_migrations (migration_id, name, created_at) VALUES (99, 'future', 'now')",
    )
    setup.close()

    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    try {
      expect(() => openWorkerRuntime(dbPath)).toThrow(/newer than this application supports/)
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      vi.restoreAllMocks()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
