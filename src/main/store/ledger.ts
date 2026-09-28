import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import * as Effect from 'effect/Effect'
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
import { NodeSqliteDatabase } from './node-sqlite-client.js'
import { LedgerRepository } from './ledger-repository.js'
import { type FileVerdict, type PortInput } from './port.js'
import { executeSqliteScript } from './sqlite-migrations.js'

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
   *  main process ports data in (ADR 0002). */
  readOnly?: boolean
}

export class LedgerStore {
  readonly dbPath: string
  private db: NodeSqliteDatabase

  constructor(dbPath: string, options: LedgerStoreOptions = {}) {
    const { readOnly = false } = options
    if (!readOnly) mkdirSync(dirname(dbPath), { recursive: true })
    this.dbPath = dbPath
    this.db = new NodeSqliteDatabase(dbPath, { readonly: readOnly })
    if (readOnly) return
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.migrate([
      {
        version: 1,
        name: 'initial_ledger_schema',
        up: executeSqliteScript(`
      CREATE TABLE IF NOT EXISTS ledger_source (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        env_fingerprint TEXT NOT NULL,
        file_path TEXT NOT NULL,
        repo_url TEXT,
        project TEXT,
        fingerprint_dev INTEGER,
        fingerprint_ino INTEGER,
        fingerprint_mtime_ms REAL,
        fingerprint_size_bytes INTEGER,
        last_ported_at TEXT,
        UNIQUE (provider, env_fingerprint, file_path)
      );

      CREATE TABLE IF NOT EXISTS ledger_call (
        source_id INTEGER NOT NULL REFERENCES ledger_source(id),
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        call_index INTEGER NOT NULL,
        dedup_key TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        speed TEXT NOT NULL DEFAULT 'standard',
        project TEXT,
        project_path TEXT,
        working_directory TEXT,
        base_cost_usd REAL NOT NULL,
        is_estimated INTEGER NOT NULL DEFAULT 0,
        savings_usd REAL NOT NULL DEFAULT 0,
        savings_baseline_model TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        web_search_requests INTEGER NOT NULL DEFAULT 0,
        cache_creation_one_hour_tokens INTEGER NOT NULL DEFAULT 0,
        agent_type TEXT,
        tools_json TEXT NOT NULL DEFAULT '[]',
        mcp_tools_json TEXT NOT NULL DEFAULT '[]',
        skills_json TEXT NOT NULL DEFAULT '[]',
        subagent_types_json TEXT NOT NULL DEFAULT '[]',
        bash_commands_json TEXT NOT NULL DEFAULT '[]',
        tool_sequence_json TEXT NOT NULL DEFAULT '[]',
        loc_added INTEGER,
        loc_removed INTEGER,
        interrupted INTEGER NOT NULL DEFAULT 0,
        user_modified INTEGER NOT NULL DEFAULT 0,
        tool_errors INTEGER NOT NULL DEFAULT 0,
        edit_failed INTEGER NOT NULL DEFAULT 0,
        call_key TEXT GENERATED ALWAYS AS (COALESCE(dedup_key, printf('%d:%d', turn_index, call_index))) STORED,
        UNIQUE (source_id, session_id, call_key)
      );

      CREATE TABLE IF NOT EXISTS ledger_turn (
        source_id INTEGER NOT NULL REFERENCES ledger_source(id),
        session_id TEXT NOT NULL,
        turn_index INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        user_message TEXT,
        git_branch TEXT,
        pr_refs_json TEXT NOT NULL DEFAULT '[]',
        spawn_tool_use_ids_json TEXT NOT NULL DEFAULT '[]',
        category TEXT NOT NULL,
        sub_category TEXT,
        retries INTEGER NOT NULL DEFAULT 0,
        has_edits INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_id, session_id, turn_index)
      );

      CREATE TABLE IF NOT EXISTS ledger_session (
        source_id INTEGER NOT NULL REFERENCES ledger_source(id),
        session_id TEXT NOT NULL,
        project TEXT,
        project_path TEXT,
        working_directory TEXT,
        canonical_project TEXT,
        canonical_cwd TEXT,
        agent_type TEXT,
        title TEXT,
        pr_links_json TEXT NOT NULL DEFAULT '[]',
        is_sidechain INTEGER NOT NULL DEFAULT 0,
        parent_session_id TEXT,
        agent_spawn_links_json TEXT NOT NULL DEFAULT '{}',
        mcp_inventory_json TEXT NOT NULL DEFAULT '[]',
        ambiguous_spawn_agent_ids_json TEXT NOT NULL DEFAULT '[]',
        ever_had_branch INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (source_id, session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_ledger_call_timestamp ON ledger_call(timestamp);
      CREATE INDEX IF NOT EXISTS idx_ledger_call_session ON ledger_call(session_id);
      CREATE INDEX IF NOT EXISTS idx_ledger_call_model ON ledger_call(model);
      CREATE INDEX IF NOT EXISTS idx_ledger_call_project ON ledger_call(project);
      CREATE INDEX IF NOT EXISTS idx_ledger_call_provider ON ledger_call(provider);

      CREATE TABLE IF NOT EXISTS model_alias (
        model TEXT PRIMARY KEY,
        alias_of TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS price_override (
        model TEXT PRIMARY KEY,
        input_price_per_million REAL NOT NULL,
        output_price_per_million REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS currency_rate (
        code TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        rate REAL NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS refresh_cadence_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        value TEXT NOT NULL DEFAULT '1m'
      );

      CREATE TABLE IF NOT EXISTS display_currency_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        code TEXT NOT NULL DEFAULT 'USD'
      );

      CREATE TABLE IF NOT EXISTS skills_dismissal_config (
        source TEXT NOT NULL,
        name TEXT NOT NULL,
        reason TEXT NOT NULL,
        created TEXT NOT NULL,
        PRIMARY KEY (source, name)
      );

      CREATE TABLE IF NOT EXISTS ledger_mcp_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        startup_mode TEXT NOT NULL DEFAULT 'on-demand'
      );
      `),
      },
    ])
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
    return this.runRepositorySync(repository => repository.portIn(input))
  }

  /** Removes a source and all of its ledger rows (per-file provenance is the
   * `modified`-replace and eviction deletion unit). */
  deleteSource(provider: string, envFingerprint: string, filePath: string): void {
    this.runRepositorySync(repository => repository.deleteSource(provider, envFingerprint, filePath))
  }

  // ── Read-back (the aggregation layer's input) ─────────────────────────

  getSources(): LedgerSourceRow[] {
    return this.runRepositorySync(repository => repository.getSources())
  }

  getSessions(): LedgerSessionRow[] {
    return this.runRepositorySync(repository => repository.getSessions())
  }

  getTurns(): LedgerTurnRow[] {
    return this.runRepositorySync(repository => repository.getTurns())
  }

  getCalls(): LedgerCallRow[] {
    return this.runRepositorySync(repository => repository.getCalls())
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
    this.runRepositorySync(repository => repository.setModelAlias(model, aliasOf))
  }

  removeModelAlias(model: string): void {
    this.runRepositorySync(repository => repository.removeModelAlias(model))
  }

  getModelAliases(): ModelAlias[] {
    return this.runRepositorySync(repository => repository.getModelAliases())
  }

  /** Pure config write: the display cost is computed query-time from tokens
   * via a LEFT JOIN onto `price_override`, so changing an override needs no
   * row updates, no `rebuildDailySpend`, and no rescan. */
  setPriceOverride(model: string, override: Omit<PriceOverride, 'model'>): void {
    this.runRepositorySync(repository => repository.setPriceOverride(model, override))
  }

  removePriceOverride(model: string): void {
    this.runRepositorySync(repository => repository.removePriceOverride(model))
  }

  getPriceOverrides(): PriceOverride[] {
    return this.runRepositorySync(repository => repository.getPriceOverrides())
  }

  setCurrencyRate(rate: CurrencyRate): void {
    this.runRepositorySync(repository => repository.setCurrencyRate(rate))
  }

  getCurrencyRate(code: string): CurrencyRate | null {
    return this.runRepositorySync(repository => repository.getCurrencyRate(code))
  }

  getDisplayCurrency(): string {
    return this.runRepositorySync(repository => repository.getDisplayCurrency())
  }

  /** Sole remaining caller is the `FxRates.layerWithStore` adapter (`fx.ts`) —
   * every former direct caller (worker `currency:set` arm, all tests) now
   * writes through the `FxRates` port (retired Wave 7 with a zero-caller grep
   * proof outside the adapter). Deletes only with a repository-direct `FxRates`
   * layer, which needs `runRepositorySync` access that lives here. */
  setDisplayCurrency(code: string): void {
    const safe = /^[A-Za-z]{3}$/.test(code) ? code.toUpperCase() : 'USD'
    this.runRepositorySync(repository => repository.setDisplayCurrency(safe))
  }

  getRefreshCadence(): string {
    return this.runRepositorySync(repository => repository.getRefreshCadence())
  }

  setRefreshCadence(value: string): void {
    const cadence = isValidCadence(value) ? value : DEFAULT_CADENCE
    this.runRepositorySync(repository => repository.setRefreshCadence(cadence))
  }

  getLedgerMcpStartupMode(): LedgerMcpStartupMode {
    return this.runRepositorySync(repository => repository.getLedgerMcpStartupMode())
  }

  setLedgerMcpStartupMode(value: unknown): LedgerMcpStartupMode {
    const parsed = ledgerMcpStartupModeSchema.safeParse(value)
    const startupMode = parsed.success ? parsed.data : 'on-demand'
    this.runRepositorySync(repository => repository.setLedgerMcpStartupMode(startupMode))
    return startupMode
  }

  /** Not-a-skill dismissals (ticket 25): candidate patterns the user rejected,
   *  filtered out of the Skills payload on every fetch. A config table (user
   *  setting), so dismissals survive `clear()`. */
  getSkillDismissals(): SkillsDismissal[] {
    return this.runRepositorySync(repository => repository.getSkillDismissals())
  }

  dismissSkill(source: SkillsDismissal['source'], name: string, reason: string): void {
    this.runRepositorySync(repository => repository.dismissSkill(source, name, reason, new Date().toISOString()))
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
    this.runRepositorySync(repository => repository.clear())
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

  private runRepositorySync<A>(operation: (repository: LedgerRepository['Service']) => Effect.Effect<A, SqlError>): A {
    return this.db.runSync(
      Effect.gen(function* () {
        const repository = yield* LedgerRepository
        return yield* operation(repository)
      }),
    )
  }
}
