import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { SqlError } from 'effect/unstable/sql/SqlError'
import { z } from 'zod'

import {
  type CurrencyRate,
  currencyRateRowSchema,
  type LedgerCallRow,
  ledgerCallRowSchema,
  type LedgerSessionRow,
  ledgerSessionRowSchema,
  type LedgerSourceRow,
  ledgerSourceRowSchema,
  type LedgerTurnRow,
  ledgerTurnRowSchema,
  type ModelAlias,
  modelAliasRowSchema,
  type PortResult,
  type PriceOverride,
  priceOverrideRowSchema,
} from '../../shared/schemas/ledger.js'
import { type LedgerMcpStartupMode, ledgerMcpStartupModeSchema } from '../../shared/schemas/ledger-mcp.js'
import type { SkillsDismissal } from '../../shared/schemas/skills.js'
import { DEFAULT_CADENCE } from '../cadence.js'
import { mapFileToLedgerRows, type PortInput } from './port.js'

type SourceInput = ReturnType<typeof mapFileToLedgerRows>['source']
type RunResult = { changes: number | bigint; lastInsertRowid: number | bigint }

/**
 * The ledger's THREE PORTS, split by concern (ADR 0032 §A3, plan F12).
 *
 * The interface used to be one 23-member `LedgerRepository` spanning ingest,
 * source lifecycle, model aliases, price overrides, currency, cadence, MCP
 * startup, skill dismissals and four bulk reads — SRP and ISP violated, and
 * unreachable except through `LedgerStore`'s per-method sync adapters. The SQL
 * did not change: ONE implementation (`LedgerImplementation` below) is still
 * built over ONE `SqlClient`, and the three tags project their members out of
 * it. This is a signature change, not a rewrite.
 *
 * `LedgerStore` and the double `runSync` round-trip are deliberately still here
 * — both die in the facade-retirement slice, which needs the view builders to
 * take `LedgerQueries` through `R` first. The ports exist now so that retirement
 * is mechanical.
 */

/** Ingest port (3 members): the scan-derived fact write path and the two
 *  deletions that belong to the same transactional unit. `portIn` is the
 *  ledger's centre of gravity — one file's whole port-in in one transaction
 *  (ADR 0002, ADR 0032). */
export interface LedgerIngestPort {
  portIn(input: PortInput): Effect.Effect<PortResult, SqlError>
  deleteSource(provider: string, envFingerprint: string, filePath: string): Effect.Effect<void, SqlError>
  clear(): Effect.Effect<void, SqlError>
}

/** Read port (4 members): the four bulk reads the query-time aggregation seam
 *  consumes (ADR 0002/0008). Every row is Zod-validated at this boundary. */
export interface LedgerQueriesPort {
  getSources(): Effect.Effect<LedgerSourceRow[], SqlError>
  getSessions(): Effect.Effect<LedgerSessionRow[], SqlError>
  getTurns(): Effect.Effect<LedgerTurnRow[], SqlError>
  getCalls(): Effect.Effect<LedgerCallRow[], SqlError>
}

/** Config port (16 members): the user settings that are NOT scan data and must
 *  survive `clear()` (ADR 0002) — model aliases, price overrides, currency
 *  rates, display currency, refresh cadence, local MCP startup mode, and
 *  not-a-skill dismissals. */
export interface LedgerConfigPort {
  getModelAliases(): Effect.Effect<ModelAlias[], SqlError>
  setModelAlias(model: string, aliasOf: string): Effect.Effect<void, SqlError>
  removeModelAlias(model: string): Effect.Effect<void, SqlError>
  getPriceOverrides(): Effect.Effect<PriceOverride[], SqlError>
  setPriceOverride(model: string, override: Omit<PriceOverride, 'model'>): Effect.Effect<void, SqlError>
  removePriceOverride(model: string): Effect.Effect<void, SqlError>
  getCurrencyRate(code: string): Effect.Effect<CurrencyRate | null, SqlError>
  setCurrencyRate(rate: CurrencyRate): Effect.Effect<void, SqlError>
  getDisplayCurrency(): Effect.Effect<string, SqlError>
  setDisplayCurrency(code: string): Effect.Effect<void, SqlError>
  getRefreshCadence(): Effect.Effect<string, SqlError>
  setRefreshCadence(value: string): Effect.Effect<void, SqlError>
  getLedgerMcpStartupMode(): Effect.Effect<LedgerMcpStartupMode, SqlError>
  setLedgerMcpStartupMode(mode: LedgerMcpStartupMode): Effect.Effect<void, SqlError>
  getSkillDismissals(): Effect.Effect<SkillsDismissal[], SqlError>
  dismissSkill(
    source: SkillsDismissal['source'],
    name: string,
    reason: string,
    created: string,
  ): Effect.Effect<void, SqlError>
}

/** All 23 members, un-split: the shape the three ports project from. */
export interface LedgerImplementationShape extends LedgerIngestPort, LedgerQueriesPort, LedgerConfigPort {}

/**
 * The ONE implementation all three ports project from — the whole hand-written
 * SQL, unchanged, over whatever `SqlClient` the owning runtime provides. Kept
 * as its own service so `LedgerIngest`/`LedgerQueries`/`LedgerConfig` can be
 * provided independently while sharing a single instance (and therefore a
 * single connection) instead of triplicating the SQL.
 *
 * Not a consumer-facing port: nothing outside this file should `yield*` it.
 */
export class LedgerImplementation extends Context.Service<LedgerImplementation, LedgerImplementationShape>()(
  'watchtower/store/LedgerImplementation',
) {
  static readonly layer = Layer.effect(
    LedgerImplementation,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const setModelAlias = Effect.fn('LedgerConfig.setModelAlias')(function* (model: string, aliasOf: string) {
        yield* sql.unsafe(
          'INSERT INTO model_alias (model, alias_of) VALUES (?, ?) ON CONFLICT(model) DO UPDATE SET alias_of = excluded.alias_of',
          [model, aliasOf],
        )
      })

      const removeModelAlias = Effect.fn('LedgerConfig.removeModelAlias')(function* (model: string) {
        yield* sql.unsafe('DELETE FROM model_alias WHERE model = ?', [model])
      })

      const getModelAliases = Effect.fn('LedgerConfig.getModelAliases')(function* () {
        const rows = yield* sql.unsafe('SELECT model, alias_of FROM model_alias')
        return z.array(modelAliasRowSchema).parse(rows)
      })

      const setPriceOverride = Effect.fn('LedgerConfig.setPriceOverride')(function* (
        model: string,
        override: Omit<PriceOverride, 'model'>,
      ) {
        yield* sql.unsafe(
          `
          INSERT INTO price_override (model, input_price_per_million, output_price_per_million) VALUES (?, ?, ?)
          ON CONFLICT(model) DO UPDATE SET input_price_per_million = excluded.input_price_per_million, output_price_per_million = excluded.output_price_per_million
        `,
          [model, override.inputPricePerMillion, override.outputPricePerMillion],
        )
      })

      const removePriceOverride = Effect.fn('LedgerConfig.removePriceOverride')(function* (model: string) {
        yield* sql.unsafe('DELETE FROM price_override WHERE model = ?', [model])
      })

      const getPriceOverrides = Effect.fn('LedgerConfig.getPriceOverrides')(function* () {
        const rows = yield* sql.unsafe(
          'SELECT model, input_price_per_million, output_price_per_million FROM price_override',
        )
        return z.array(priceOverrideRowSchema).parse(rows)
      })

      const getSources = Effect.fn('LedgerQueries.getSources')(function* () {
        const rows = yield* sql.unsafe(`
          SELECT id, provider, env_fingerprint, file_path, repo_url, project,
                 CAST(fingerprint_dev AS TEXT) AS fingerprint_dev,
                 CAST(fingerprint_ino AS TEXT) AS fingerprint_ino,
                 fingerprint_mtime_ms, fingerprint_size_bytes, last_ported_at
          FROM ledger_source ORDER BY id ASC
        `)
        return z.array(ledgerSourceRowSchema).parse(rows)
      })

      const getSessions = Effect.fn('LedgerQueries.getSessions')(function* () {
        const rows = yield* sql.unsafe(`
          SELECT source_id, session_id, project, project_path, working_directory, canonical_project, canonical_cwd,
                 agent_type, title, pr_links_json, is_sidechain, parent_session_id, agent_spawn_links_json,
                 mcp_inventory_json, ambiguous_spawn_agent_ids_json, ever_had_branch
          FROM ledger_session ORDER BY session_id ASC
        `)
        return z.array(ledgerSessionRowSchema).parse(rows)
      })

      const getTurns = Effect.fn('LedgerQueries.getTurns')(function* () {
        const rows = yield* sql.unsafe(`
          SELECT source_id, session_id, turn_index, timestamp, user_message, git_branch, pr_refs_json,
                 spawn_tool_use_ids_json, category, sub_category, retries, has_edits
          FROM ledger_turn ORDER BY session_id ASC, turn_index ASC
        `)
        return z.array(ledgerTurnRowSchema).parse(rows)
      })

      const getCalls = Effect.fn('LedgerQueries.getCalls')(function* () {
        const rows = yield* sql.unsafe(`
          SELECT source_id, session_id, turn_index, call_index, call_key, dedup_key, provider, model, timestamp, speed,
                 project, project_path, working_directory, base_cost_usd, is_estimated, savings_usd, savings_baseline_model,
                 input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cached_input_tokens,
                 reasoning_tokens, web_search_requests, cache_creation_one_hour_tokens, agent_type,
                 tools_json, mcp_tools_json, skills_json, subagent_types_json, bash_commands_json,
                 tool_sequence_json,
                 loc_added, loc_removed, interrupted, user_modified, tool_errors, edit_failed
          FROM ledger_call ORDER BY session_id ASC, turn_index ASC, call_index ASC
        `)
        return z.array(ledgerCallRowSchema).parse(rows)
      })

      const getCurrencyRate = Effect.fn('LedgerConfig.getCurrencyRate')(function* (code: string) {
        const rows = yield* sql.unsafe('SELECT code, symbol, rate, updated_at FROM currency_rate WHERE code = ?', [
          code,
        ])
        const row = rows[0]
        return row ? currencyRateRowSchema.parse(row) : null
      })

      const getDisplayCurrency = Effect.fn('LedgerConfig.getDisplayCurrency')(function* () {
        const rows = yield* sql.unsafe('SELECT code FROM display_currency_config WHERE id = 1')
        const row = rows[0] as { code: string } | undefined
        return row?.code ?? 'USD'
      })

      const getRefreshCadence = Effect.fn('LedgerConfig.getRefreshCadence')(function* () {
        const rows = yield* sql.unsafe('SELECT value FROM refresh_cadence_config WHERE id = 1')
        const row = rows[0] as { value: string } | undefined
        return row?.value ?? DEFAULT_CADENCE
      })

      const getLedgerMcpStartupMode = Effect.fn('LedgerConfig.getLedgerMcpStartupMode')(function* () {
        const rows = yield* sql.unsafe('SELECT startup_mode FROM ledger_mcp_config WHERE id = 1')
        const row = rows[0] as { startup_mode: unknown } | undefined
        const parsed = ledgerMcpStartupModeSchema.safeParse(row?.startup_mode)
        return parsed.success ? parsed.data : 'on-demand'
      })

      const getSkillDismissals = Effect.fn('LedgerConfig.getSkillDismissals')(function* () {
        const rows = yield* sql.unsafe('SELECT source, name, reason, created FROM skills_dismissal_config')
        return [...rows] as SkillsDismissal[]
      })

      const setCurrencyRate = Effect.fn('LedgerConfig.setCurrencyRate')(function* (rate: CurrencyRate) {
        yield* sql.unsafe(
          `
          INSERT INTO currency_rate (code, symbol, rate, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(code) DO UPDATE SET symbol = excluded.symbol, rate = excluded.rate, updated_at = excluded.updated_at
        `,
          [rate.code, rate.symbol, rate.rate, rate.updatedAt],
        )
      })

      const setDisplayCurrency = Effect.fn('LedgerConfig.setDisplayCurrency')(function* (code: string) {
        yield* sql.unsafe(
          `
          INSERT INTO display_currency_config (id, code) VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET code = excluded.code
        `,
          [code],
        )
      })

      const setRefreshCadence = Effect.fn('LedgerConfig.setRefreshCadence')(function* (value: string) {
        yield* sql.unsafe(
          `
          INSERT INTO refresh_cadence_config (id, value) VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET value = excluded.value
        `,
          [value],
        )
      })

      const setLedgerMcpStartupMode = Effect.fn('LedgerConfig.setLedgerMcpStartupMode')(function* (
        mode: LedgerMcpStartupMode,
      ) {
        yield* sql.unsafe(
          `
          INSERT INTO ledger_mcp_config (id, startup_mode) VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET startup_mode = excluded.startup_mode
        `,
          [mode],
        )
      })

      const dismissSkill = Effect.fn('LedgerConfig.dismissSkill')(function* (
        source: SkillsDismissal['source'],
        name: string,
        reason: string,
        created: string,
      ) {
        yield* sql.unsafe(
          `
          INSERT INTO skills_dismissal_config (source, name, reason, created)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(source, name) DO UPDATE SET reason = excluded.reason, created = excluded.created
        `,
          [source, name, reason, created],
        )
      })

      const findSourceId = Effect.fnUntraced(function* (provider: string, envFingerprint: string, filePath: string) {
        const rows = yield* sql.unsafe(
          'SELECT id FROM ledger_source WHERE provider = ? AND env_fingerprint = ? AND file_path = ?',
          [provider, envFingerprint, filePath],
        )
        const row = rows[0] as { id: number } | undefined
        return row ? Number(row.id) : null
      })

      const upsertSource = Effect.fnUntraced(function* (
        source: SourceInput,
        now: string,
        repoUrl?: string,
        project?: string,
      ) {
        const existing = yield* findSourceId(source.provider, source.envFingerprint, source.filePath)
        if (existing !== null) {
          yield* sql.unsafe(
            `
            UPDATE ledger_source SET
              fingerprint_dev = ?, fingerprint_ino = ?, fingerprint_mtime_ms = ?, fingerprint_size_bytes = ?,
              repo_url = CASE WHEN ? IS NOT NULL THEN ? ELSE repo_url END,
              project = CASE WHEN ? IS NOT NULL THEN ? ELSE project END,
              last_ported_at = ?
            WHERE id = ?
          `,
            [
              source.fingerprint.dev,
              source.fingerprint.ino,
              source.fingerprint.mtimeMs,
              source.fingerprint.sizeBytes,
              repoUrl ?? null,
              repoUrl ?? null,
              project ?? null,
              project ?? null,
              now,
              existing,
            ],
          )
          return existing
        }

        const result = (yield* sql.unsafe(
          `
          INSERT INTO ledger_source (
            provider, env_fingerprint, file_path, repo_url, project,
            fingerprint_dev, fingerprint_ino, fingerprint_mtime_ms, fingerprint_size_bytes, last_ported_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          [
            source.provider,
            source.envFingerprint,
            source.filePath,
            repoUrl ?? null,
            project ?? null,
            source.fingerprint.dev,
            source.fingerprint.ino,
            source.fingerprint.mtimeMs,
            source.fingerprint.sizeBytes,
            now,
          ],
        ).raw) as unknown as RunResult
        return Number(result.lastInsertRowid)
      })

      const deleteSourceRows = Effect.fnUntraced(function* (sourceId: number) {
        yield* sql.unsafe('DELETE FROM ledger_call WHERE source_id = ?', [sourceId])
        yield* sql.unsafe('DELETE FROM ledger_turn WHERE source_id = ?', [sourceId])
        yield* sql.unsafe('DELETE FROM ledger_session WHERE source_id = ?', [sourceId])
      })

      const deleteSource = Effect.fn('LedgerIngest.deleteSource')(function* (
        provider: string,
        envFingerprint: string,
        filePath: string,
      ): Effect.fn.Return<void, SqlError> {
        const sourceId = yield* findSourceId(provider, envFingerprint, filePath)
        if (sourceId === null) return
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* deleteSourceRows(sourceId)
            yield* sql.unsafe('DELETE FROM ledger_source WHERE id = ?', [sourceId])
          }),
        )
      })

      const insertSessions = Effect.fnUntraced(function* (
        sourceId: number,
        session: ReturnType<typeof mapFileToLedgerRows>['session'],
      ) {
        const result = (yield* sql.unsafe(
          `
          INSERT OR IGNORE INTO ledger_session (
            source_id, session_id, project, project_path, working_directory, canonical_project, canonical_cwd,
            agent_type, title, pr_links_json, is_sidechain, parent_session_id, agent_spawn_links_json, mcp_inventory_json,
            ambiguous_spawn_agent_ids_json, ever_had_branch
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
          [
            sourceId,
            session.sessionId,
            session.project,
            session.projectPath,
            session.workingDirectory,
            session.canonicalProject,
            session.canonicalCwd,
            session.agentType,
            session.title,
            JSON.stringify(session.prLinks),
            session.isSidechain ? 1 : 0,
            session.parentSessionId,
            JSON.stringify(session.agentSpawnLinks),
            JSON.stringify(session.mcpInventory),
            JSON.stringify(session.ambiguousSpawnAgentIds),
            session.everHadBranch ? 1 : 0,
          ],
        ).raw) as unknown as RunResult
        return Number(result.changes)
      })

      const insertTurns = Effect.fnUntraced(function* (
        sourceId: number,
        turns: ReturnType<typeof mapFileToLedgerRows>['turns'],
      ) {
        let inserted = 0
        for (const turn of turns) {
          const result = (yield* sql.unsafe(
            `
            INSERT OR IGNORE INTO ledger_turn (
              source_id, session_id, turn_index, timestamp, user_message, git_branch, pr_refs_json,
              spawn_tool_use_ids_json, category, sub_category, retries, has_edits
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
            [
              sourceId,
              turn.sessionId,
              turn.turnIndex,
              turn.timestamp,
              turn.userMessage,
              turn.gitBranch,
              JSON.stringify(turn.prRefs),
              JSON.stringify(turn.spawnToolUseIds),
              turn.category,
              turn.subCategory,
              turn.retries,
              turn.hasEdits ? 1 : 0,
            ],
          ).raw) as unknown as RunResult
          inserted += Number(result.changes)
        }
        return inserted
      })

      const insertCalls = Effect.fnUntraced(function* (
        sourceId: number,
        calls: ReturnType<typeof mapFileToLedgerRows>['calls'],
      ) {
        let inserted = 0
        for (const call of calls) {
          const result = (yield* sql.unsafe(
            `
            INSERT OR IGNORE INTO ledger_call (
              source_id, session_id, turn_index, call_index, dedup_key, provider, model, timestamp, speed,
              project, project_path, working_directory, base_cost_usd, is_estimated, savings_usd, savings_baseline_model,
              input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cached_input_tokens,
              reasoning_tokens, web_search_requests, cache_creation_one_hour_tokens, agent_type,
              tools_json, mcp_tools_json, skills_json, subagent_types_json, bash_commands_json,
              tool_sequence_json,
              loc_added, loc_removed, interrupted, user_modified, tool_errors, edit_failed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
            [
              sourceId,
              call.sessionId,
              call.turnIndex,
              call.callIndex,
              call.dedupKey,
              call.provider,
              call.model,
              call.timestamp,
              call.speed,
              call.project,
              call.projectPath,
              call.workingDirectory,
              call.baseCostUSD,
              call.isEstimated ? 1 : 0,
              call.savingsUSD,
              call.savingsBaselineModel,
              call.inputTokens,
              call.outputTokens,
              call.cacheCreationInputTokens,
              call.cacheReadInputTokens,
              call.cachedInputTokens,
              call.reasoningTokens,
              call.webSearchRequests,
              call.cacheCreationOneHourTokens,
              call.agentType,
              JSON.stringify(call.tools),
              JSON.stringify(call.mcpTools),
              JSON.stringify(call.skills),
              JSON.stringify(call.subagentTypes),
              JSON.stringify(call.bashCommands),
              JSON.stringify(call.toolSequence),
              call.locAdded,
              call.locRemoved,
              call.interrupted ? 1 : 0,
              call.userModified ? 1 : 0,
              call.toolErrors,
              call.editFailed,
            ],
          ).raw) as unknown as RunResult
          inserted += Number(result.changes)
        }
        return inserted
      })

      const clear = Effect.fn('LedgerIngest.clear')(function* (): Effect.fn.Return<void, SqlError> {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe('DELETE FROM ledger_call')
            yield* sql.unsafe('DELETE FROM ledger_turn')
            yield* sql.unsafe('DELETE FROM ledger_session')
            yield* sql.unsafe('DELETE FROM ledger_source')
          }),
        )
      })

      const portIn = Effect.fn('LedgerIngest.portIn')(function* (
        input: PortInput,
      ): Effect.fn.Return<PortResult, SqlError> {
        const { provider, envFingerprint, filePath, verdict, cachedFile, repoUrl, durable } = input

        if (verdict === 'unchanged') {
          const sourceId = yield* findSourceId(provider, envFingerprint, filePath)
          if (sourceId !== null || cachedFile.failed) {
            return { verdict, sourceId, inserted: { sessions: 0, turns: 0, calls: 0 } }
          }
        }

        const mapped = mapFileToLedgerRows(input)
        const now = new Date().toISOString()

        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const sourceId = yield* upsertSource(mapped.source, now, repoUrl, input.project)
            if (verdict === 'modified' && !durable) yield* deleteSourceRows(sourceId)
            const inserted = {
              sessions: yield* insertSessions(sourceId, mapped.session),
              turns: yield* insertTurns(sourceId, mapped.turns),
              calls: yield* insertCalls(sourceId, mapped.calls),
            }
            return { verdict, sourceId, inserted }
          }),
        )
      })

      return LedgerImplementation.of({
        portIn,
        clear,
        deleteSource,
        setModelAlias,
        removeModelAlias,
        getModelAliases,
        setPriceOverride,
        removePriceOverride,
        getPriceOverrides,
        getSources,
        getSessions,
        getTurns,
        getCalls,
        getCurrencyRate,
        getDisplayCurrency,
        getRefreshCadence,
        getLedgerMcpStartupMode,
        getSkillDismissals,
        setCurrencyRate,
        setDisplayCurrency,
        setRefreshCadence,
        setLedgerMcpStartupMode,
        dismissSkill,
      })
    }),
  )
}

/**
 * `LedgerIngest` — the ledger's write port (3 members). Independently providable
 * and independently fakeable; the implementation is shared, not copied.
 */
export class LedgerIngest extends Context.Service<LedgerIngest, LedgerIngestPort>()('watchtower/store/LedgerIngest') {
  static readonly layer = Layer.effect(
    LedgerIngest,
    Effect.map(LedgerImplementation, implementation =>
      LedgerIngest.of({
        portIn: implementation.portIn,
        deleteSource: implementation.deleteSource,
        clear: implementation.clear,
      }),
    ),
  )
}

/**
 * `LedgerQueries` — the ledger's read port (4 members), the one the query-time
 * view builders will take through `R` so `LedgerStore` loses its last callers.
 */
export class LedgerQueries extends Context.Service<LedgerQueries, LedgerQueriesPort>()(
  'watchtower/store/LedgerQueries',
) {
  static readonly layer = Layer.effect(
    LedgerQueries,
    Effect.map(LedgerImplementation, implementation =>
      LedgerQueries.of({
        getSources: implementation.getSources,
        getSessions: implementation.getSessions,
        getTurns: implementation.getTurns,
        getCalls: implementation.getCalls,
      }),
    ),
  )
}

/**
 * `LedgerConfig` — the ledger's settings port (16 members), the tables that
 * survive `clear()` (ADR 0002) and repaint every view with no rescan.
 */
export class LedgerConfig extends Context.Service<LedgerConfig, LedgerConfigPort>()('watchtower/store/LedgerConfig') {
  static readonly layer = Layer.effect(
    LedgerConfig,
    Effect.map(LedgerImplementation, implementation =>
      LedgerConfig.of({
        getModelAliases: implementation.getModelAliases,
        setModelAlias: implementation.setModelAlias,
        removeModelAlias: implementation.removeModelAlias,
        getPriceOverrides: implementation.getPriceOverrides,
        setPriceOverride: implementation.setPriceOverride,
        removePriceOverride: implementation.removePriceOverride,
        getCurrencyRate: implementation.getCurrencyRate,
        setCurrencyRate: implementation.setCurrencyRate,
        getDisplayCurrency: implementation.getDisplayCurrency,
        setDisplayCurrency: implementation.setDisplayCurrency,
        getRefreshCadence: implementation.getRefreshCadence,
        setRefreshCadence: implementation.setRefreshCadence,
        getLedgerMcpStartupMode: implementation.getLedgerMcpStartupMode,
        setLedgerMcpStartupMode: implementation.setLedgerMcpStartupMode,
        getSkillDismissals: implementation.getSkillDismissals,
        dismissSkill: implementation.dismissSkill,
      }),
    ),
  )
}

/**
 * All three ports from ONE `LedgerImplementation`, with the implementation kept
 * private (ADR 0032 §A3) and the `SqlClient` left as the layer's requirement —
 * the connection is the caller's to own, so this composes over whatever single
 * writer the owning runtime already has. `NodeSqliteDatabase` builds it over the
 * ledger's writer connection and re-projects the resulting instances through
 * `portsLayer` for a second composition root, rather than opening another
 * connection.
 */
export const LedgerPortsLayer: Layer.Layer<LedgerIngest | LedgerQueries | LedgerConfig, never, SqlClient.SqlClient> =
  Layer.mergeAll(LedgerIngest.layer, LedgerQueries.layer, LedgerConfig.layer).pipe(
    Layer.provide(LedgerImplementation.layer),
  )
