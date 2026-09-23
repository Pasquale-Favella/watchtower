import { DatabaseSync } from 'node:sqlite'

import { describe, expect, it } from 'vitest'

import { runSqliteMigrations } from '../src/main/store/sqlite-migrations.js'

describe('SQLite migrations', () => {
  it('applies migrations in order once and records the latest version', () => {
    const db = new DatabaseSync(':memory:')
    try {
      const migrations = [
        { version: 1, up: (connection: DatabaseSync) => connection.exec('CREATE TABLE item (value TEXT NOT NULL)') },
        { version: 2, up: (connection: DatabaseSync) => connection.exec("INSERT INTO item (value) VALUES ('kept')") },
      ]

      runSqliteMigrations(db, migrations)
      runSqliteMigrations(db, migrations)

      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2)
      expect(db.prepare('SELECT value FROM item').get()).toEqual({ value: 'kept' })
    } finally {
      db.close()
    }
  })

  it('rolls back partial DDL and does not advance the version when a migration fails', () => {
    const db = new DatabaseSync(':memory:')
    try {
      expect(() => runSqliteMigrations(db, [{
        version: 1,
        up: connection => connection.exec('CREATE TABLE partial (value TEXT); INVALID SQL'),
      }])).toThrow()

      expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(0)
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial'").get()).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('rejects non-contiguous migration sequences and databases newer than the app', () => {
    const db = new DatabaseSync(':memory:')
    try {
      expect(() => runSqliteMigrations(db, [{ version: 2, up: () => {} }])).toThrow(/contiguous/)
      db.exec('PRAGMA user_version = 2')
      expect(() => runSqliteMigrations(db, [{ version: 1, up: () => {} }])).toThrow(/newer than this application/)
    } finally {
      db.close()
    }
  })
})