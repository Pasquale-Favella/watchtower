import type { DatabaseSync } from 'node:sqlite'

export interface SqliteMigration {
  version: number
  up: (db: DatabaseSync) => void
}

export function runSqliteMigrations(db: DatabaseSync, migrations: readonly SqliteMigration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`SQLite migrations must be contiguous from version 1; found ${migration.version} at position ${index + 1}`)
    }
  })

  const current = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (current.user_version > migrations.length) {
    throw new Error(`Database schema version ${current.user_version} is newer than this application supports (${migrations.length})`)
  }

  let currentVersion = current.user_version
  for (const migration of migrations) {
    if (migration.version <= currentVersion) continue

    db.exec('BEGIN IMMEDIATE')
    try {
      migration.up(db)
      db.exec(`PRAGMA user_version = ${migration.version}`)
      db.exec('COMMIT')
      currentVersion = migration.version
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the migration error if SQLite has already rolled back.
      }
      throw error
    }
  }
}