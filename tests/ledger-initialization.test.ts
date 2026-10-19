import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import * as SqlClient from 'effect/sql/SqlClient'
import { describe, expect, it, vi } from 'vitest'

import { initializeLedger } from '../src/main/store/ledger-initialization.js'
import { makeWorkerRuntime, openWorkerRuntime } from '../src/main/worker-runtime.js'

describe('ledger initialization', () => {
  it('applies the shared schema migrations once and accepts a repeated initialization', async () => {
    const runtime = makeWorkerRuntime(':memory:')
    try {
      runtime.runSync(initializeLedger)
      runtime.runSync(initializeLedger)
      const sql = runtime.runSync(SqlClient.SqlClient)

      expect(runtime.runSync(sql.unsafe('SELECT migration_id, name FROM watchtower_sql_migrations'))).toEqual([
        { migration_id: 1, name: 'initial_ledger_schema' },
        { migration_id: 2, name: 'index_session_detail_reads' },
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

  it('upgrades a version 1 ledger without changing its facts or configuration', async () => {
    const runtime = makeWorkerRuntime(':memory:')
    try {
      runtime.runSync(initializeLedger)
      const sql = runtime.runSync(SqlClient.SqlClient)
      runtime.runSync(
        sql.unsafe(
          "INSERT INTO ledger_source (provider, env_fingerprint, file_path, repo_url) VALUES ('opencode', 'env', '/session.json', 'https://example.com/repo')",
        ),
      )
      runtime.runSync(
        sql.unsafe(
          "INSERT INTO ledger_session (source_id, session_id, title) VALUES (1, 'session-to-preserve', 'preserved title')",
        ),
      )
      runtime.runSync(
        sql.unsafe(
          "INSERT INTO ledger_turn (source_id, session_id, turn_index, timestamp, category) VALUES (1, 'session-to-preserve', 3, '2026-01-01T00:00:00.000Z', 'implementation')",
        ),
      )
      runtime.runSync(sql.unsafe("INSERT INTO display_currency_config (id, code) VALUES (1, 'EUR')"))

      // Restore the version 1 boundary while retaining its original schema and rows.
      runtime.runSync(sql.unsafe('DROP INDEX idx_ledger_session_session'))
      runtime.runSync(sql.unsafe('DROP INDEX idx_ledger_turn_session_turn'))
      runtime.runSync(sql.unsafe('DELETE FROM watchtower_sql_migrations WHERE migration_id = 2'))
      expect(runtime.runSync(sql.unsafe('SELECT migration_id, name FROM watchtower_sql_migrations'))).toEqual([
        { migration_id: 1, name: 'initial_ledger_schema' },
      ])

      runtime.runSync(initializeLedger)

      expect(runtime.runSync(sql.unsafe('SELECT migration_id, name FROM watchtower_sql_migrations'))).toEqual([
        { migration_id: 1, name: 'initial_ledger_schema' },
        { migration_id: 2, name: 'index_session_detail_reads' },
      ])
      expect(runtime.runSync(sql.unsafe('SELECT session_id, title FROM ledger_session'))).toEqual([
        { session_id: 'session-to-preserve', title: 'preserved title' },
      ])
      expect(runtime.runSync(sql.unsafe('SELECT session_id, turn_index FROM ledger_turn'))).toEqual([
        { session_id: 'session-to-preserve', turn_index: 3 },
      ])
      expect(runtime.runSync(sql.unsafe('SELECT code FROM display_currency_config'))).toEqual([{ code: 'EUR' }])
      expect(
        runtime.runSync(
          sql.unsafe(
            "SELECT name FROM sqlite_master WHERE name IN ('idx_ledger_session_session', 'idx_ledger_turn_session_turn') ORDER BY name",
          ),
        ),
      ).toEqual([{ name: 'idx_ledger_session_session' }, { name: 'idx_ledger_turn_session_turn' }])
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
