import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { DEFAULT_CADENCE, isValidCadence } from '../cadence.js'
import {
  mapFileToLedgerRows,
  type FileVerdict,
  type MappedCall,
  type MappedFingerprint,
  type MappedSession,
  type MappedTurn,
  type PortInput,
} from './port.js'
import {
  currencyRateRowSchema,
  ledgerCallRowSchema,
  ledgerSessionRowSchema,
  ledgerSourceRowSchema,
  ledgerTurnRowSchema,
  modelAliasRowSchema,
  priceOverrideRowSchema,
  type CurrencyRate,
  type LedgerCallRow,
  type LedgerSessionRow,
  type LedgerSourceRow,
  type LedgerTurnRow,
  type ModelAlias,
  type PortResult,
  type PriceOverride,
} from '../../shared/schemas/ledger.js'

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
 * The accumulating ledger (map tickets 01 + 06): four `ledger_*` tables that
 * store only what the transcripts observed — per-call facts with raw tokens +
 * the pipeline's `base_cost_usd` (never a repriced cost), per-turn persisted
 * classification, per-session transcript facts, and per-source provenance.
 * Everything a view shows is re-derived at query time; nothing is materialized.
 *
 * Config tables (model aliases, price overrides, currency, refresh cadence,
 * display currency) are NOT scan data: they are user/app settings that survive
 * `clear()`.
 */
export class LedgerStore {
  readonly dbPath: string
  private db: DatabaseSync

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.dbPath = dbPath
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;

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
    `)
    // Greenfield: no migration path exists — the app is not yet distributed, so
    // a pre-ledger install is reset by deleting the dev ledger (the session
    // cache stays, and the first scan's lifetime port-in backfills it). Schema
    // evolution here is CREATE TABLE IF NOT EXISTS only.
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
    const { provider, envFingerprint, filePath, verdict, cachedFile, repoUrl, durable } = input

    if (verdict === 'unchanged') {
      const sourceId = this.findSourceId(provider, envFingerprint, filePath)
      // Warm cache predating the ledger — the greenfield first scan (dev ledger
      // cleared while the session cache stays warm) or a resumed interrupted
      // scan: the fingerprint matches, but there is no ledger row yet — this is
      // really a first port, not a no-op. Failed files stay skipped (nothing to
      // port). Idempotent once present.
      if (sourceId !== null || cachedFile.failed) {
        return { verdict, sourceId, inserted: { sessions: 0, turns: 0, calls: 0 } }
      }
    }

    const mapped = mapFileToLedgerRows(input)
    const now = new Date().toISOString()

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const sourceId = this.upsertSource(mapped.source, now, repoUrl, input.project)
      // Durable sources union-merge instead of replace: a `modified` verdict must
      // NOT drop already-ported rows (the cache only ever appends unioned turns,
      // and pruned-span data is intentionally preserved). The call_key conflict
      // rule makes re-insertion a no-op.
      if (verdict === 'modified' && !durable) {
        this.deleteSourceRows(sourceId)
      }
      const inserted = {
        sessions: this.insertSessions(sourceId, mapped.session),
        turns: this.insertTurns(sourceId, mapped.turns),
        calls: this.insertCalls(sourceId, mapped.calls),
      }
      this.db.exec('COMMIT')
      return { verdict, sourceId, inserted }
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  private findSourceId(provider: string, envFingerprint: string, filePath: string): number | null {
    const row = this.db
      .prepare('SELECT id FROM ledger_source WHERE provider = ? AND env_fingerprint = ? AND file_path = ?')
      .get(provider, envFingerprint, filePath) as { id: number } | undefined
    return row ? Number(row.id) : null
  }

  private upsertSource(source: { provider: string; envFingerprint: string; filePath: string; fingerprint: MappedFingerprint }, now: string, repoUrl?: string, project?: string): number {
    const existing = this.findSourceId(source.provider, source.envFingerprint, source.filePath)
    if (existing !== null) {
      this.db.prepare(`
        UPDATE ledger_source SET
          fingerprint_dev = ?, fingerprint_ino = ?, fingerprint_mtime_ms = ?, fingerprint_size_bytes = ?,
          repo_url = CASE WHEN ? IS NOT NULL THEN ? ELSE repo_url END,
          project = CASE WHEN ? IS NOT NULL THEN ? ELSE project END,
          last_ported_at = ?
        WHERE id = ?
      `).run(
        source.fingerprint.dev, source.fingerprint.ino, source.fingerprint.mtimeMs, source.fingerprint.sizeBytes,
        repoUrl ?? null, repoUrl ?? null, project ?? null, project ?? null, now, existing
      )
      return existing
    }
    const result = this.db.prepare(`
      INSERT INTO ledger_source (provider, env_fingerprint, file_path, repo_url, project, fingerprint_dev, fingerprint_ino, fingerprint_mtime_ms, fingerprint_size_bytes, last_ported_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      source.provider, source.envFingerprint, source.filePath, repoUrl ?? null, project ?? null,
      source.fingerprint.dev, source.fingerprint.ino, source.fingerprint.mtimeMs, source.fingerprint.sizeBytes, now
    )
    return Number(result.lastInsertRowid)
  }

  private insertSessions(sourceId: number, session: MappedSession): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO ledger_session (
        source_id, session_id, project, project_path, working_directory, canonical_project, canonical_cwd,
        agent_type, title, pr_links_json, is_sidechain, parent_session_id, agent_spawn_links_json, mcp_inventory_json,
        ambiguous_spawn_agent_ids_json, ever_had_branch
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    return Number(stmt.run(
      sourceId, session.sessionId, session.project, session.projectPath, session.workingDirectory,
      session.canonicalProject, session.canonicalCwd, session.agentType, session.title,
      JSON.stringify(session.prLinks), session.isSidechain ? 1 : 0, session.parentSessionId,
      JSON.stringify(session.agentSpawnLinks), JSON.stringify(session.mcpInventory),
      JSON.stringify(session.ambiguousSpawnAgentIds), session.everHadBranch ? 1 : 0
    ).changes)
  }

  private insertTurns(sourceId: number, turns: MappedTurn[]): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO ledger_turn (
        source_id, session_id, turn_index, timestamp, user_message, git_branch, pr_refs_json,
        spawn_tool_use_ids_json, category, sub_category, retries, has_edits
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    let inserted = 0
    for (const turn of turns) {
      inserted += Number(stmt.run(
        sourceId, turn.sessionId, turn.turnIndex, turn.timestamp, turn.userMessage, turn.gitBranch,
        JSON.stringify(turn.prRefs), JSON.stringify(turn.spawnToolUseIds), turn.category, turn.subCategory, turn.retries, turn.hasEdits ? 1 : 0
      ).changes)
    }
    return inserted
  }

  private insertCalls(sourceId: number, calls: MappedCall[]): number {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO ledger_call (
        source_id, session_id, turn_index, call_index, dedup_key, provider, model, timestamp, speed,
        project, project_path, working_directory, base_cost_usd, is_estimated, savings_usd, savings_baseline_model,
        input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cached_input_tokens,
        reasoning_tokens, web_search_requests, cache_creation_one_hour_tokens, agent_type,
        tools_json, mcp_tools_json, skills_json, subagent_types_json, bash_commands_json,
        tool_sequence_json,
        loc_added, loc_removed, interrupted, user_modified, tool_errors, edit_failed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    let inserted = 0
    for (const call of calls) {
      inserted += Number(stmt.run(
        sourceId, call.sessionId, call.turnIndex, call.callIndex, call.dedupKey, call.provider, call.model, call.timestamp, call.speed,
        call.project, call.projectPath, call.workingDirectory, call.baseCostUSD, call.isEstimated ? 1 : 0, call.savingsUSD, call.savingsBaselineModel,
        call.inputTokens, call.outputTokens, call.cacheCreationInputTokens, call.cacheReadInputTokens, call.cachedInputTokens,
        call.reasoningTokens, call.webSearchRequests, call.cacheCreationOneHourTokens, call.agentType,
        JSON.stringify(call.tools), JSON.stringify(call.mcpTools), JSON.stringify(call.skills), JSON.stringify(call.subagentTypes),
        JSON.stringify(call.bashCommands), JSON.stringify(call.toolSequence),
        call.locAdded, call.locRemoved, call.interrupted ? 1 : 0, call.userModified ? 1 : 0, call.toolErrors, call.editFailed
      ).changes)
    }
    return inserted
  }

  /** Removes a source and all of its ledger rows (per-file provenance is the
   * `modified`-replace and eviction deletion unit). */
  deleteSource(provider: string, envFingerprint: string, filePath: string): void {
    const sourceId = this.findSourceId(provider, envFingerprint, filePath)
    if (sourceId === null) return
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.deleteSourceRows(sourceId)
      this.db.prepare('DELETE FROM ledger_source WHERE id = ?').run(sourceId)
      this.db.exec('COMMIT')
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  private deleteSourceRows(sourceId: number): void {
    this.db.prepare('DELETE FROM ledger_call WHERE source_id = ?').run(sourceId)
    this.db.prepare('DELETE FROM ledger_turn WHERE source_id = ?').run(sourceId)
    this.db.prepare('DELETE FROM ledger_session WHERE source_id = ?').run(sourceId)
  }

  // ── Read-back (the aggregation layer's input) ─────────────────────────

  getSources(): LedgerSourceRow[] {
    // CAST dev/ino to TEXT before node:sqlite ever touches the integers: an
    // NTFS inode above 2^53 would otherwise throw ERR_OUT_OF_RANGE instead of
    // reading back. mtimeMs/sizeBytes stay numeric (REAL / small int). The
    // schema's transform performs the column mapping + null→undefined shaping.
    const rows = this.db.prepare(`
      SELECT id, provider, env_fingerprint, file_path, repo_url, project,
             CAST(fingerprint_dev AS TEXT) AS fingerprint_dev,
             CAST(fingerprint_ino AS TEXT) AS fingerprint_ino,
             fingerprint_mtime_ms, fingerprint_size_bytes, last_ported_at
      FROM ledger_source ORDER BY id ASC
    `).all() as Array<Record<string, unknown>>
    return z.array(ledgerSourceRowSchema).parse(rows)
  }

  getSessions(): LedgerSessionRow[] {
    const rows = this.db.prepare(`
      SELECT source_id, session_id, project, project_path, working_directory, canonical_project, canonical_cwd,
             agent_type, title, pr_links_json, is_sidechain, parent_session_id, agent_spawn_links_json,
             mcp_inventory_json, ambiguous_spawn_agent_ids_json, ever_had_branch
      FROM ledger_session ORDER BY session_id ASC
    `).all() as Array<Record<string, unknown>>
    return z.array(ledgerSessionRowSchema).parse(rows)
  }

  getTurns(): LedgerTurnRow[] {
    const rows = this.db.prepare(`
      SELECT source_id, session_id, turn_index, timestamp, user_message, git_branch, pr_refs_json,
             spawn_tool_use_ids_json, category, sub_category, retries, has_edits
      FROM ledger_turn ORDER BY session_id ASC, turn_index ASC
    `).all() as Array<Record<string, unknown>>
    return z.array(ledgerTurnRowSchema).parse(rows)
  }

  getCalls(): LedgerCallRow[] {
    const rows = this.db.prepare(`
      SELECT source_id, session_id, turn_index, call_index, call_key, dedup_key, provider, model, timestamp, speed,
             project, project_path, working_directory, base_cost_usd, is_estimated, savings_usd, savings_baseline_model,
             input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cached_input_tokens,
             reasoning_tokens, web_search_requests, cache_creation_one_hour_tokens, agent_type,
             tools_json, mcp_tools_json, skills_json, subagent_types_json, bash_commands_json,
             tool_sequence_json,
             loc_added, loc_removed, interrupted, user_modified, tool_errors, edit_failed
      FROM ledger_call ORDER BY session_id ASC, turn_index ASC, call_index ASC
    `).all() as Array<Record<string, unknown>>
    return z.array(ledgerCallRowSchema).parse(rows)
  }

  // ── Schema introspection (green-field verification) ───────────────────

  getTableNames(): string[] {
    const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
    return rows.map(r => r.name)
  }

  getIndexNames(table: string): string[] {
    const rows = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?").all(table) as Array<{ name: string }>
    return rows.map(r => r.name).filter(name => !name.startsWith('sqlite_autoindex_'))
  }

  // ── Config tables: not scan data, survive clear() ─────────────────────

  setModelAlias(model: string, aliasOf: string): void {
    this.db.prepare('INSERT INTO model_alias (model, alias_of) VALUES (?, ?) ON CONFLICT(model) DO UPDATE SET alias_of = excluded.alias_of')
      .run(model, aliasOf)
  }

  removeModelAlias(model: string): void {
    this.db.prepare('DELETE FROM model_alias WHERE model = ?').run(model)
  }

  getModelAliases(): ModelAlias[] {
    const rows = this.db.prepare('SELECT model, alias_of FROM model_alias').all() as Array<Record<string, unknown>>
    return z.array(modelAliasRowSchema).parse(rows)
  }

  /** Pure config write: the display cost is computed query-time from tokens
   * via a LEFT JOIN onto `price_override`, so changing an override needs no
   * row updates, no `rebuildDailySpend`, and no rescan. */
  setPriceOverride(model: string, override: Omit<PriceOverride, 'model'>): void {
    this.db.prepare(`
      INSERT INTO price_override (model, input_price_per_million, output_price_per_million) VALUES (?, ?, ?)
      ON CONFLICT(model) DO UPDATE SET input_price_per_million = excluded.input_price_per_million, output_price_per_million = excluded.output_price_per_million
    `).run(model, override.inputPricePerMillion, override.outputPricePerMillion)
  }

  removePriceOverride(model: string): void {
    this.db.prepare('DELETE FROM price_override WHERE model = ?').run(model)
  }

  getPriceOverrides(): PriceOverride[] {
    const rows = this.db
      .prepare('SELECT model, input_price_per_million, output_price_per_million FROM price_override')
      .all() as Array<Record<string, unknown>>
    return z.array(priceOverrideRowSchema).parse(rows)
  }

  setCurrencyRate(rate: CurrencyRate): void {
    this.db.prepare(`
      INSERT INTO currency_rate (code, symbol, rate, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET symbol = excluded.symbol, rate = excluded.rate, updated_at = excluded.updated_at
    `).run(rate.code, rate.symbol, rate.rate, rate.updatedAt)
  }

  getCurrencyRate(code: string): CurrencyRate | null {
    const row = this.db.prepare('SELECT code, symbol, rate, updated_at FROM currency_rate WHERE code = ?').get(code) as Record<string, unknown> | undefined
    if (!row) return null
    return currencyRateRowSchema.parse(row)
  }

  getDisplayCurrency(): string {
    const row = this.db.prepare('SELECT code FROM display_currency_config WHERE id = 1').get() as
      | { code: string }
      | undefined
    return row?.code ?? 'USD'
  }

  setDisplayCurrency(code: string): void {
    const safe = /^[A-Za-z]{3}$/.test(code) ? code.toUpperCase() : 'USD'
    this.db.prepare(`
      INSERT INTO display_currency_config (id, code) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET code = excluded.code
    `).run(safe)
  }

  getRefreshCadence(): string {
    const row = this.db.prepare('SELECT value FROM refresh_cadence_config WHERE id = 1').get() as
      | { value: string }
      | undefined
    return row?.value ?? DEFAULT_CADENCE
  }

  setRefreshCadence(value: string): void {
    const cadence = isValidCadence(value) ? value : DEFAULT_CADENCE
    this.db.prepare(`
      INSERT INTO refresh_cadence_config (id, value) VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET value = excluded.value
    `).run(cadence)
  }

  /** Clears all scan-derived ledger data. Config tables are user settings and
   * are left untouched. */
  clear(): void {
    this.db.exec(`
      DELETE FROM ledger_call;
      DELETE FROM ledger_turn;
      DELETE FROM ledger_session;
      DELETE FROM ledger_source;
    `)
  }

  close(): void {
    this.db.close()
  }
}
