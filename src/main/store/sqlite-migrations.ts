import * as Effect from 'effect/Effect'
import * as Migrator from 'effect/unstable/sql/Migrator'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { SqlError } from 'effect/unstable/sql/SqlError'

export interface SqliteMigration {
  version: number
  name: string
  up: Effect.Effect<void, unknown, SqlClient.SqlClient>
}

export function executeSqliteScript(script: string): Effect.Effect<void, SqlError, SqlClient.SqlClient> {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    for (const statement of script
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)) {
      yield* sql.unsafe(statement)
    }
  })
}

export function makeSqliteMigrationLoader(migrations: readonly SqliteMigration[]): Migrator.Loader {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `SQLite migrations must be contiguous from version 1; found ${migration.version} at position ${index + 1}`,
      )
    }
    if (!migration.name.trim()) throw new Error(`SQLite migration ${migration.version} must have a name`)
  })

  return Migrator.fromRecord(
    Object.fromEntries(migrations.map(migration => [`${migration.version}_${migration.name}`, migration.up])),
  )
}
