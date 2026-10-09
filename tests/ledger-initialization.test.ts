import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it, vi } from 'vitest'

import { LedgerStore } from '../src/main/store/ledger.js'
import { initializeLedger } from '../src/main/store/ledger-initialization.js'
import { NodeSqliteDatabase } from '../src/main/store/node-sqlite-client.js'

describe('ledger initialization', () => {
  it('applies the shared schema migration once and accepts a repeated initialization', () => {
    const database = new NodeSqliteDatabase(':memory:')
    try {
      database.runSync(initializeLedger)
      database.runSync(initializeLedger)

      expect(database.prepare('SELECT migration_id, name FROM watchtower_sql_migrations').all()).toEqual([
        { migration_id: 1, name: 'initial_ledger_schema' },
      ])
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_source'").get(),
      ).toEqual({ name: 'ledger_source' })
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_mcp_config'").get(),
      ).toEqual({ name: 'ledger_mcp_config' })
    } finally {
      database.close()
    }
  })

  it('rejects a future schema after the migrator leaves its history intact', () => {
    const database = new NodeSqliteDatabase(':memory:')
    try {
      database.exec(
        "CREATE TABLE watchtower_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL); INSERT INTO watchtower_sql_migrations (migration_id, name, created_at) VALUES (99, 'future', 'now')",
      )

      expect(() => database.runSync(initializeLedger)).toThrow(/newer than this application supports/)
      expect(database.prepare('SELECT migration_id FROM watchtower_sql_migrations').all()).toEqual([
        { migration_id: 99 },
      ])
    } finally {
      database.close()
    }
  })

  it('closes the standalone connection when constructor initialization rejects a future schema', () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-ledger-init-'))
    const dbPath = join(directory, 'nested', 'ledger.db')
    mkdirSync(dirname(dbPath), { recursive: true })
    const setup = new NodeSqliteDatabase(dbPath)
    setup.exec(
      "CREATE TABLE watchtower_sql_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL); INSERT INTO watchtower_sql_migrations (migration_id, name, created_at) VALUES (99, 'future', 'now')",
    )
    setup.close()

    const close = vi.spyOn(DatabaseSync.prototype, 'close')
    try {
      expect(() => new LedgerStore(dbPath)).toThrow(/newer than this application supports/)
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      vi.restoreAllMocks()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
