import * as SqliteMigrator from '@effect/sql-sqlite-node/SqliteMigrator'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import { executeSqliteScript, makeSqliteMigrationLoader } from './sqlite-migrations.js'

export class UnsupportedLedgerSchemaVersion extends Schema.TaggedError<UnsupportedLedgerSchemaVersion>()(
  'UnsupportedLedgerSchemaVersion',
  { version: Schema.Number, latestSupported: Schema.Number, message: Schema.String },
) {}

const migrations = [
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
] as const

const latestSupportedVersion = migrations.at(-1)?.version ?? 0
const loader = makeSqliteMigrationLoader(migrations)

export const initializeLedger: Effect.Effect<
  void,
  SqliteMigrator.MigrationError | SqlError | UnsupportedLedgerSchemaVersion,
  SqlClient.SqlClient
> = Effect.gen(function* () {
  yield* SqliteMigrator.run({ loader, table: 'watchtower_sql_migrations' })

  const sql = yield* SqlClient.SqlClient
  const rows = (yield* sql.unsafe(
    'SELECT COALESCE(MAX(migration_id), 0) AS version FROM watchtower_sql_migrations',
  )) as {
    readonly version: number
  }[]
  const version = Number(rows[0]?.version ?? 0)
  if (version > latestSupportedVersion) {
    return yield* new UnsupportedLedgerSchemaVersion({
      version,
      latestSupported: latestSupportedVersion,
      message: `Database schema version ${version} is newer than this application supports (${latestSupportedVersion})`,
    })
  }
})
