import * as SqliteMigrator from '@effect/sql-sqlite-node/SqliteMigrator'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import { SqlError } from 'effect/sql/SqlError'

export interface SqliteMigration {
  version: number
  name: string
  up: Effect.Effect<void, SqlError, SqlClient.SqlClient>
}

export class UnsupportedLedgerSchemaVersion extends Schema.TaggedError<UnsupportedLedgerSchemaVersion>()(
  'UnsupportedLedgerSchemaVersion',
  { version: Schema.Number, latestSupported: Schema.Number, message: Schema.String },
) {}

export class InvalidSqliteMigrationDefinition extends Schema.TaggedError<InvalidSqliteMigrationDefinition>()(
  'InvalidSqliteMigrationDefinition',
  { message: Schema.String },
) {}

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

function makeSqliteMigrationLoader(migrations: readonly SqliteMigration[]): SqliteMigrator.Loader {
  return SqliteMigrator.fromRecord(
    Object.fromEntries(migrations.map(migration => [`${migration.version}_${migration.name}`, migration.up])),
  )
}

export function runSqliteMigrations(
  migrations: readonly SqliteMigration[],
): Effect.Effect<
  void,
  SqliteMigrator.MigrationError | SqlError | UnsupportedLedgerSchemaVersion | InvalidSqliteMigrationDefinition,
  SqlClient.SqlClient
> {
  const latestSupported = migrations.at(-1)?.version ?? 0
  return Effect.gen(function* () {
    for (const [index, migration] of migrations.entries()) {
      if (migration.version !== index + 1) {
        return yield* new InvalidSqliteMigrationDefinition({
          message: `SQLite migrations must be contiguous from version 1; found ${migration.version} at position ${index + 1}`,
        })
      }
      if (!migration.name.trim()) {
        return yield* new InvalidSqliteMigrationDefinition({
          message: `SQLite migration ${migration.version} must have a name`,
        })
      }
    }

    const loader = makeSqliteMigrationLoader(migrations)
    yield* SqliteMigrator.run({ loader, table: 'watchtower_sql_migrations' })
    const sql = yield* SqlClient.SqlClient
    const rows = (yield* sql.unsafe(
      'SELECT COALESCE(MAX(migration_id), 0) AS version FROM watchtower_sql_migrations',
    )) as { readonly version: number }[]
    const version = Number(rows[0]?.version ?? 0)
    if (version > latestSupported) {
      return yield* new UnsupportedLedgerSchemaVersion({
        version,
        latestSupported,
        message: `Database schema version ${version} is newer than this application supports (${latestSupported})`,
      })
    }
  })
}
