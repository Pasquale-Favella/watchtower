import * as SqlClient from 'effect/sql/SqlClient'
import { describe, expect, it } from 'vitest'

import { executeSqliteScript, runSqliteMigrations } from '../src/main/store/sqlite-migrations.js'
import { withNativeSqliteRuntime } from './fixtures/native-sqlite-runtime.js'

describe('SQLite migrations', () => {
  it('applies migrations in order once and records the latest version', async () => {
    await withNativeSqliteRuntime(':memory:', runtime => {
      const sql = runtime.runSync(SqlClient.SqlClient)
      const migrations = [
        {
          version: 1,
          name: 'create_item',
          up: executeSqliteScript('CREATE TABLE item (value TEXT NOT NULL)'),
        },
        {
          version: 2,
          name: 'seed_item',
          up: executeSqliteScript("INSERT INTO item (value) VALUES ('kept')"),
        },
      ]

      runtime.runSync(runSqliteMigrations(migrations))
      runtime.runSync(runSqliteMigrations(migrations))

      expect(
        runtime.runSync(sql.unsafe('SELECT migration_id, name FROM watchtower_sql_migrations ORDER BY migration_id')),
      ).toEqual([
        { migration_id: 1, name: 'create_item' },
        { migration_id: 2, name: 'seed_item' },
      ])
      expect(runtime.runSync(sql.unsafe('SELECT value FROM item'))[0]).toEqual({ value: 'kept' })
    })
  })

  it('rolls back migration DDL and journal entries when a migration fails', async () => {
    await withNativeSqliteRuntime(':memory:', runtime => {
      const sql = runtime.runSync(SqlClient.SqlClient)
      expect(() =>
        runtime.runSync(
          runSqliteMigrations([
            {
              version: 1,
              name: 'create_partial',
              up: executeSqliteScript('CREATE TABLE partial (value TEXT)'),
            },
            {
              version: 2,
              name: 'fail',
              up: executeSqliteScript('INVALID SQL'),
            },
          ]),
        ),
      ).toThrow()

      expect(runtime.runSync(sql.unsafe('SELECT migration_id FROM watchtower_sql_migrations'))).toEqual([])
      expect(
        runtime.runSync(sql.unsafe("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial'"))[0],
      ).toBeUndefined()
    })
  })

  it('rejects non-contiguous migration sequences and databases newer than the app', async () => {
    await withNativeSqliteRuntime(':memory:', runtime => {
      expect(() =>
        runtime.runSync(runSqliteMigrations([{ version: 2, name: 'gap', up: executeSqliteScript('SELECT 1') }])),
      ).toThrow(/contiguous/)
      expect(() =>
        runtime.runSync(runSqliteMigrations([{ version: 1, name: ' ', up: executeSqliteScript('SELECT 1') }])),
      ).toThrow(/must have a name/)
      runtime.runSync(
        runSqliteMigrations([
          { version: 1, name: 'one', up: executeSqliteScript('SELECT 1') },
          { version: 2, name: 'two', up: executeSqliteScript('SELECT 1') },
        ]),
      )
      expect(() =>
        runtime.runSync(runSqliteMigrations([{ version: 1, name: 'one', up: executeSqliteScript('SELECT 1') }])),
      ).toThrow(/newer than this application/)
    })
  })
})
