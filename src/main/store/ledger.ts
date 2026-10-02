import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import { SqlError } from 'effect/unstable/sql/SqlError'

import {
  type CurrencyRate,
  type LedgerCallRow,
  type LedgerSessionRow,
  type LedgerSourceRow,
  type LedgerTurnRow,
  type ModelAlias,
  type PortResult,
  type PriceOverride,
} from '../../shared/schemas/ledger.js'
import { type LedgerMcpStartupMode, ledgerMcpStartupModeSchema } from '../../shared/schemas/ledger-mcp.js'
import type { SkillsDismissal } from '../../shared/schemas/skills.js'
import { DEFAULT_CADENCE, isValidCadence } from '../cadence.js'
import { initializeLedger } from './ledger-initialization.js'
import { LedgerConfig, LedgerIngest, LedgerQueries } from './ledger-repository.js'
import { type LedgerRuntime, NodeSqliteDatabase } from './node-sqlite-client.js'
import type { PortInput } from './port.js'
import type { LedgerCallFactsRow } from './read-projections.js'

export type {
  CurrencyRate,
  LedgerCallRow,
  LedgerSessionRow,
  LedgerSourceRow,
  LedgerTurnRow,
  ModelAlias,
  PortResult,
  PriceOverride,
} from '../../shared/schemas/ledger.js'

/**
 * The accumulating ledger (ADRs 0002 + 0011): four `ledger_*` tables that
 * store only what the transcripts observed — per-call facts with raw tokens +
 * the pipeline's `base_cost_usd` (never a repriced cost), per-turn persisted
 * classification, per-session transcript facts, and per-source provenance.
 * Everything a view shows is re-derived at query time; nothing is materialized.
 *
 * Config tables (model aliases, price overrides, currency, refresh cadence,
 * display currency, local MCP startup) are NOT scan data: they are user/app
 * settings that survive `clear()`.
 */
export interface LedgerStoreOptions {
  /** Open the ledger READ-ONLY (the in-app ledger MCP server's second
   *  connection, map 53). Skips the DDL — a read-only connection cannot run
   *  CREATE TABLE, and this instance must never write: only the owning
   *  db-worker ports data in (ADR 0002, ADR 0023). */
  readOnly?: boolean
  /** Borrow the application-owned worker runtime and its writer connection.
   *  This is used only by the db-worker compatibility facade; standalone
   *  callers keep owning the database runtime they construct. */
  runtime?: LedgerRuntime
  /** Skip only after the worker root initialized this borrowed runtime; remove with the facade. */
  initialize?: false
}

export class LedgerStore {
  readonly dbPath: string
  private db: NodeSqliteDatabase

  constructor(dbPath: string, options: LedgerStoreOptions = {}) {
    const { readOnly = false } = options
    if (!readOnly) mkdirSync(dirname(dbPath), { recursive: true })
    this.dbPath = dbPath
    this.db = new NodeSqliteDatabase(dbPath, { readonly: readOnly, runtime: options.runtime })
    if (readOnly) return
    if (options.initialize !== false) {
      try {
        this.db.runSync(initializeLedger)
      } catch (error) {
        try {
          this.db.close()
        } catch {
          // Preserve the initialization failure.
        }
        throw error
      }
    }
  }

  // ── Port-in write path ────────────────────────────────────────────────

  /** Ports one session-cache file into the ledger, idempotently:
   * `new`/`appended` insert with ON-CONFLICT-IGNORE (the generated `call_key`
   * constraint rejects a re-ported row, so a streaming re-emission can never
   * double-count); `modified` replaces that source's rows atomically
   * (delete + insert in one transaction); `unchanged` touches nothing — UNLESS
   * the source was never ported (an empty ledger met by a warm session cache,
   * or a crash between the cache save and the first port). The ledger is its
   * own resume marker: `ledger_source` presence decides, so a first-time
   * `unchanged` file falls through to the full port below and the `call_key`
   * constraint keeps any partial re-port idempotent. */
  portIn(input: PortInput): PortResult {
    return this.runIngestSync(ingest => ingest.portIn(input))
  }

  /** Removes a source and all of its ledger rows (per-file provenance is the
   * `modified`-replace and eviction deletion unit). */
  deleteSource(provider: string, envFingerprint: string, filePath: string): void {
    this.runIngestSync(ingest => ingest.deleteSource(provider, envFingerprint, filePath))
  }

  // ── Read-back (the aggregation layer's input) ─────────────────────────

  getSources(): LedgerSourceRow[] {
    return this.runQueriesSync(queries => queries.getSources())
  }

  getSessions(): LedgerSessionRow[] {
    return this.runQueriesSync(queries => queries.getSessions())
  }

  getTurns(): LedgerTurnRow[] {
    return this.runQueriesSync(queries => queries.getTurns())
  }

  getCalls(): LedgerCallRow[] {
    return this.runQueriesSync(queries => queries.getCalls())
  }

  /**
   * The same `ledger_call` rows as `getCalls`, shaped to what the query-time
   * aggregation seam reads: 29 of the 38 columns, with the nine no consumer
   * reads omitted (`store/read-projections.ts` carries the per-column map).
   * `getCalls` stays as the wide fallback; this is the one the Section builders
   * read, through `store/aggregate.ts`.
   *
   * Same removal condition as the runners below: deleted with the facade, once
   * the view builders take `LedgerQueries` through the worker runtime's `R`.
   */
  getCallFacts(): LedgerCallFactsRow[] {
    return this.runQueriesSync(queries => queries.getCallFacts())
  }

  // ── Schema introspection (green-field verification) ───────────────────

  getTableNames(): string[] {
    const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    return rows.map(r => r.name)
  }

  getIndexNames(table: string): string[] {
    const rows = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
      .all(table) as Array<{ name: string }>
    return rows.map(r => r.name).filter(name => !name.startsWith('sqlite_autoindex_'))
  }

  // ── Config tables: not scan data, survive clear() ─────────────────────

  setModelAlias(model: string, aliasOf: string): void {
    this.runRepositorySync(config => config.setModelAlias(model, aliasOf))
  }

  removeModelAlias(model: string): void {
    this.runRepositorySync(config => config.removeModelAlias(model))
  }

  getModelAliases(): ModelAlias[] {
    return this.runRepositorySync(config => config.getModelAliases())
  }

  /** Pure config write: the display cost is computed query-time from tokens
   * via a LEFT JOIN onto `price_override`, so changing an override needs no
   * row updates, no `rebuildDailySpend`, and no rescan. */
  setPriceOverride(model: string, override: Omit<PriceOverride, 'model'>): void {
    this.runRepositorySync(config => config.setPriceOverride(model, override))
  }

  removePriceOverride(model: string): void {
    this.runRepositorySync(config => config.removePriceOverride(model))
  }

  getPriceOverrides(): PriceOverride[] {
    return this.runRepositorySync(config => config.getPriceOverrides())
  }

  setCurrencyRate(rate: CurrencyRate): void {
    this.runRepositorySync(config => config.setCurrencyRate(rate))
  }

  getCurrencyRate(code: string): CurrencyRate | null {
    return this.runRepositorySync(config => config.getCurrencyRate(code))
  }

  getDisplayCurrency(): string {
    return this.runRepositorySync(config => config.getDisplayCurrency())
  }

  getRefreshCadence(): string {
    return this.runRepositorySync(config => config.getRefreshCadence())
  }

  setRefreshCadence(value: string): void {
    const cadence = isValidCadence(value) ? value : DEFAULT_CADENCE
    this.runRepositorySync(config => config.setRefreshCadence(cadence))
  }

  getLedgerMcpStartupMode(): LedgerMcpStartupMode {
    return this.runRepositorySync(config => config.getLedgerMcpStartupMode())
  }

  setLedgerMcpStartupMode(value: unknown): LedgerMcpStartupMode {
    const parsed = Schema.decodeUnknownResult(ledgerMcpStartupModeSchema)(value)
    const startupMode = parsed._tag === 'Success' ? parsed.success : 'on-demand'
    this.runRepositorySync(config => config.setLedgerMcpStartupMode(startupMode))
    return startupMode
  }

  /** Not-a-skill dismissals (ticket 25): candidate patterns the user rejected,
   *  filtered out of the Skills payload on every fetch. A config table (user
   *  setting), so dismissals survive `clear()`. */
  getSkillDismissals(): SkillsDismissal[] {
    return this.runRepositorySync(config => config.getSkillDismissals())
  }

  dismissSkill(source: SkillsDismissal['source'], name: string, reason: string): void {
    this.runRepositorySync(config => config.dismissSkill(source, name, reason, new Date().toISOString()))
  }

  /** Clears all scan-derived ledger data. Config tables are user settings and
   * are left untouched. A bare DELETE would leave the file size unchanged
   * (freed pages stay in the freelist and the WAL keeps them), so the
   * Settings › Privacy & data sizes would look untouched after a clear —
   * VACUUM reclaims the pages and the checkpoint truncates the WAL, in this
   * order, so `statSync`-based sizes drop while the connection stays open.
   * The reclaim is best-effort: it needs a lock state VACUUM can take
   * exclusively, and transient states (a file lock held by a scanner, an I/O
   * error) must never fail the clear — the DELETEs above are already
   * committed, so the data is gone regardless and only the size display lags
   * until the next successful reclaim. */
  clear(): void {
    this.runIngestSync(ingest => ingest.clear())
    try {
      this.db.exec(`VACUUM;`)
      this.db.exec(`PRAGMA wal_checkpoint(TRUNCATE);`)
    } catch {
      // Best-effort reclaim (see above): never fail the clear for it.
    }
  }

  close(): void {
    this.db.close()
  }

  /**
   * The three ledger ports (ADR 0032 §A3) as a `Layer`, retained for standalone
   * compatibility callers. The db-worker now composes `LedgerPortsLayer` over
   * its application-owned SQLite layer directly; it does not use this getter.
   *
   * Removal condition: deleted with the facade after worker dispatch, view
   * builders and standalone adapters no longer depend on its synchronous
   * methods or compatibility layer.
   */
  get portsLayer(): Layer.Layer<LedgerIngest | LedgerQueries | LedgerConfig> {
    return this.db.portsLayer
  }

  /**
   * Temporary synchronous `LedgerConfig` runner for facade methods and the
   * standalone FX adapter. Production FX composes the config port directly.
   * Retain the historical name until those callers migrate, then delete this
   * runner with LedgerStore. Each runner executes on its owning thread.
   */
  runRepositorySync<A>(
    operation: (config: LedgerConfig['Service']) => Effect.Effect<A, SqlError | Schema.SchemaError>,
  ): A {
    return this.db.runSync(
      Effect.gen(function* () {
        const config = yield* LedgerConfig
        return yield* operation(config)
      }),
    )
  }

  /** `LedgerIngest` analogue (port-in / deleteSource / clear). The double
   *  `runSync` round-trip it performs is the F12 finding's other half, and it
   *  dies with the facade: removal condition is the same — the dispatch arms
   *  reach `LedgerIngest` through the worker runtime's `R`. */
  runIngestSync<A>(operation: (ingest: LedgerIngest['Service']) => Effect.Effect<A, SqlError>): A {
    return this.db.runSync(
      Effect.gen(function* () {
        const ingest = yield* LedgerIngest
        return yield* operation(ingest)
      }),
    )
  }

  /** `LedgerQueries` analogue of `runIngestSync` (the four bulk reads).
   *  Same removal condition as `runIngestSync`. */
  runQueriesSync<A>(
    operation: (queries: LedgerQueries['Service']) => Effect.Effect<A, SqlError | Schema.SchemaError>,
  ): A {
    return this.db.runSync(
      Effect.gen(function* () {
        const queries = yield* LedgerQueries
        return yield* operation(queries)
      }),
    )
  }
}
