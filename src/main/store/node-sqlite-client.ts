import * as Sqlite from '@effect/sql-sqlite-node'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { LedgerConfig, LedgerIngest, LedgerPortsLayer, LedgerQueries } from './ledger-repository.js'
import { makeSqliteMigrationLoader, type SqliteMigration } from './sqlite-migrations.js'

type RunResult = {
  changes: number | bigint
  lastInsertRowid: number | bigint
}

type SqliteStatement = {
  all(...params: unknown[]): Record<string, unknown>[]
  get(...params: unknown[]): Record<string, unknown> | undefined
  run(...params: unknown[]): RunResult
}

/** The three ledger ports (ADR 0032 §A3) — the shape every ledger consumer
 *  should depend on, and the only `R` a `runSync` caller needs. */
export type LedgerPorts = LedgerIngest | LedgerQueries | LedgerConfig

/** Effect SQL-backed SQLite access with the ledger's synchronous store contract. */
export class NodeSqliteDatabase {
  private readonly runtime: ManagedRuntime.ManagedRuntime<
    Sqlite.SqliteClient.SqliteClient | SqlClient.SqlClient | LedgerIngest | LedgerQueries | LedgerConfig,
    never
  >

  constructor(filename: string, options: { readonly readonly?: boolean } = {}) {
    const sqliteLayer = Sqlite.SqliteClient.layer({ filename, readonly: options.readonly })
    this.runtime = ManagedRuntime.make(LedgerPortsLayer.pipe(Layer.provideMerge(sqliteLayer)))
  }

  runSync<A, E>(effect: Effect.Effect<A, E, LedgerPorts>): A {
    return this.runtime.runSync(effect)
  }

  /** The three ports as a `Layer`, for a composition root that already owns THIS
   *  connection — the db-worker's `WorkerLive` supplies them this way rather
   *  than building a second `SqliteClient` over the same file. The single-writer
   *  invariant (ADR 0023) is why this is a projection of the existing runtime
   *  rather than a fresh repository build; the ports are therefore the SAME
   *  instances `runSync` already reaches, sharing one connection. */
  get portsLayer(): Layer.Layer<LedgerPorts> {
    return Layer.unwrap(Effect.map(this.runtime.contextEffect, context => Layer.succeedContext(context)))
  }

  exec(script: string): void {
    for (const statement of script
      .split(';')
      .map(part => part.trim())
      .filter(Boolean)) {
      this.execute(statement)
    }
  }

  prepare(query: string): SqliteStatement {
    return {
      all: (...params) => this.execute(query, params) as Record<string, unknown>[],
      get: (...params) => (this.execute(query, params) as Record<string, unknown>[])[0],
      run: (...params) => this.execute(query, params, true) as RunResult,
    }
  }

  transactionSync<A>(body: () => A): A {
    this.exec('BEGIN IMMEDIATE')
    try {
      const result = body()
      this.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.exec('ROLLBACK')
      } catch {
        // Preserve the transaction body's error.
      }
      throw error
    }
  }

  migrate(migrations: readonly SqliteMigration[]): void {
    const loader = makeSqliteMigrationLoader(migrations)
    this.runtime.runSync(Sqlite.SqliteMigrator.run({ loader, table: 'watchtower_sql_migrations' }))

    const latestSupported = migrations.at(-1)?.version ?? 0
    const applied = this.prepare(
      'SELECT COALESCE(MAX(migration_id), 0) AS version FROM watchtower_sql_migrations',
    ).get() as { version: number } | undefined
    if (Number(applied?.version ?? 0) > latestSupported) {
      throw new Error(
        `Database schema version ${applied?.version} is newer than this application supports (${latestSupported})`,
      )
    }
  }

  close(): void {
    this.runtime.runSync(this.runtime.disposeEffect)
  }

  private execute(query: string, params: readonly unknown[] = [], raw = false): unknown {
    return this.runtime.runSync(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const statement = sql.unsafe(query, params)
        return yield* raw ? statement.raw : statement
      }),
    )
  }
}
