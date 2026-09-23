import { describe, expect, it } from 'vitest'

import { NodeSqliteDatabase } from '../src/main/store/node-sqlite-client.js'
import { executeSqliteScript } from '../src/main/store/sqlite-migrations.js'

describe('SQLite migrations', () => {
  it('applies migrations in order once and records the latest version', () => {
    const database = new NodeSqliteDatabase(':memory:')
    try {
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

      database.migrate(migrations)
      database.migrate(migrations)

      expect(
        database.prepare('SELECT migration_id, name FROM watchtower_sql_migrations ORDER BY migration_id').all(),
      ).toEqual([
        { migration_id: 1, name: 'create_item' },
        { migration_id: 2, name: 'seed_item' },
      ])
      expect(database.prepare('SELECT value FROM item').get()).toEqual({ value: 'kept' })
    } finally {
      database.close()
    }
  })

  it('rolls back migration DDL and journal entries when a migration fails', () => {
    const database = new NodeSqliteDatabase(':memory:')
    try {
      expect(() =>
        database.migrate([
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
      ).toThrow()

      expect(database.prepare('SELECT migration_id FROM watchtower_sql_migrations').all()).toEqual([])
      expect(
        database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial'").get(),
      ).toBeUndefined()
    } finally {
      database.close()
    }
  })

  it('rejects non-contiguous migration sequences and databases newer than the app', () => {
    const database = new NodeSqliteDatabase(':memory:')
    try {
      expect(() => database.migrate([{ version: 2, name: 'gap', up: executeSqliteScript('SELECT 1') }])).toThrow(
        /contiguous/,
      )
      database.migrate([
        { version: 1, name: 'one', up: executeSqliteScript('SELECT 1') },
        { version: 2, name: 'two', up: executeSqliteScript('SELECT 1') },
      ])
      expect(() => database.migrate([{ version: 1, name: 'one', up: executeSqliteScript('SELECT 1') }])).toThrow(
        /newer than this application/,
      )
    } finally {
      database.close()
    }
  })
})
