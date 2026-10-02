import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { SqlError } from 'effect/unstable/sql/SqlError'

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
  modelAliasRowSchema,
  type PortResult,
  type PriceOverride,
  priceOverrideRowSchema,
} from '../../shared/schemas/ledger.js'
import { type LedgerMcpStartupMode, ledgerMcpStartupModeSchema } from '../../shared/schemas/ledger-mcp.js'
import type { SkillsDismissal } from '../../shared/schemas/skills.js'
import { DEFAULT_CADENCE } from '../cadence.js'
import {
  LedgerConfig,
  type LedgerConfigPort,
  LedgerIngest,
  type LedgerIngestPort,
  LedgerQueries,
  type LedgerQueriesPort,
  type LedgerRequestSnapshotData,
} from './ledger-ports.js'
import { mapFileToLedgerRows, type PortInput } from './port.js'
import { type LedgerCallFactsRow, ledgerCallFactsRowSchema } from './read-projections.js'

export {
  LedgerConfig,
  type LedgerConfigPort,
  LedgerIngest,
  type LedgerIngestPort,
  LedgerQueries,
  type LedgerQueriesPort,
  type LedgerRequestSnapshotData,
} from './ledger-ports.js'

type SourceInput = ReturnType<typeof mapFileToLedgerRows>['source']
type RunResult = { changes: number | bigint; lastInsertRowid: number | bigint }

/**
 * Every bulk read decodes its rows with `Schema.decodeUnknownEffect`, so a
 * malformed row — a truncated `*_json` cell, a schema drift, a `NaN` where the
 * DDL promised a number — fails with a `SchemaError` in the typed error
 * channel. The old `z.array(<rowSchema>).parse(rows)` THREW, and inside
 * `Effect.gen` a throw is a DEFECT in `Cause`, not a modelled failure: one bad
 * row took a whole Section down with an error the operational log has no code
 * for. `catchTag('SchemaError', …)` can now degrade past it.
 *
 * This is an internal signature change and not a wire change. Every channel
 * name, payload shape and byte is unchanged; only the ports' `E` widened.
 */
const decodeRows = <S extends Schema.Constraint>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.mutable(Schema.Array(schema)))

const SELECT_MODEL_ALIASES = 'SELECT model, alias_of FROM model_alias'
const SELECT_PRICE_OVERRIDES = `
  SELECT model, input_price_per_million, output_price_per_million FROM price_override
`
const SELECT_SOURCES = `
  SELECT id, provider, env_fingerprint, file_path, repo_url, project,
         CAST(fingerprint_dev AS TEXT) AS fingerprint_dev,
         CAST(fingerprint_ino AS TEXT) AS fingerprint_ino,
         fingerprint_mtime_ms, fingerprint_size_bytes, last_ported_at
  FROM ledger_source ORDER BY id ASC
`
const SELECT_SESSIONS = `
  SELECT source_id, session_id, project, project_path, working_directory, canonical_project, canonical_cwd,
         agent_type, title, pr_links_json, is_sidechain, parent_session_id, agent_spawn_links_json,
         mcp_inventory_json, ambiguous_spawn_agent_ids_json, ever_had_branch
  FROM ledger_session ORDER BY session_id ASC
`
const SELECT_TURNS = `
  SELECT source_id, session_id, turn_index, timestamp, user_message, git_branch, pr_refs_json,
         spawn_tool_use_ids_json, category, sub_category, retries, has_edits
  FROM ledger_turn ORDER BY session_id ASC, turn_index ASC
`
const SELECT_CALLS = `
  SELECT source_id, session_id, turn_index, call_index, call_key, dedup_key, provider, model, timestamp, speed,
         project, project_path, working_directory, base_cost_usd, is_estimated, savings_usd, savings_baseline_model,
         input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cached_input_tokens,
         reasoning_tokens, web_search_requests, cache_creation_one_hour_tokens, agent_type,
         tools_json, mcp_tools_json, skills_json, subagent_types_json, bash_commands_json,
         tool_sequence_json,
         loc_added, loc_removed, interrupted, user_modified, tool_errors, edit_failed
  FROM ledger_call ORDER BY session_id ASC, turn_index ASC, call_index ASC
`
const SELECT_CALL_FACTS = `
  SELECT source_id, session_id, turn_index, call_index, dedup_key, provider, model, timestamp, speed,
         project, working_directory, base_cost_usd, is_estimated, savings_usd, savings_baseline_model,
         input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cached_input_tokens,
         reasoning_tokens, web_search_requests, cache_creation_one_hour_tokens,
         tools_json, mcp_tools_json, skills_json, subagent_types_json, bash_commands_json,
         tool_sequence_json
  FROM ledger_call ORDER BY session_id ASC, turn_index ASC, call_index ASC
`

/** Shared implementation of the three ledger ports. */
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
        const rows = yield* sql.unsafe(SELECT_MODEL_ALIASES)
        return yield* decodeRows(modelAliasRowSchema)(rows)
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
        const rows = yield* sql.unsafe(SELECT_PRICE_OVERRIDES)
        return yield* decodeRows(priceOverrideRowSchema)(rows)
      })

      const getSources = Effect.fn('LedgerQueries.getSources')(function* () {
        const rows = yield* sql.unsafe(SELECT_SOURCES)
        return yield* decodeRows(ledgerSourceRowSchema)(rows)
      })

      const getSessions = Effect.fn('LedgerQueries.getSessions')(function* () {
        const rows = yield* sql.unsafe(SELECT_SESSIONS)
        return yield* decodeRows(ledgerSessionRowSchema)(rows)
      })

      const getTurns = Effect.fn('LedgerQueries.getTurns')(function* () {
        const rows = yield* sql.unsafe(SELECT_TURNS)
        return yield* decodeRows(ledgerTurnRowSchema)(rows)
      })

      const getCalls = Effect.fn('LedgerQueries.getCalls')(function* () {
        const rows = yield* sql.unsafe(SELECT_CALLS)
        return yield* decodeRows(ledgerCallRowSchema)(rows)
      })

      /** The same rows, shaped to what the query-time aggregation seam reads:
       *  29 of `getCalls`'s 38 columns, in the same order, over the same index
       *  path. The nine it drops have no reader anywhere in `src/main` — the
       *  per-column consumption map with `file:line` for every kept column is
       *  the doc comment on `ledgerCallFactsRowSchema` (`./read-projections.ts`),
       *  and `tests/ledger-narrow-reads.test.ts` re-derives the dropped half by
       *  scanning the consumer files. `getCalls` itself is unchanged: it is the
       *  fallback, and `scripts/measure-query-path.cjs` measures it as the
       *  comparison baseline, so the two stay independently checkable.
       *
       *  Measured effect on a 500k-call ledger: the dropped columns are 126 B of
       *  a 710 B call row (17.7%, derived from a 2,000-row clone sample), of
       *  which `call_key` alone is 34.1 B — a STORED generated column SQLite has
       *  to materialise for every row. */
      const getCallFacts = Effect.fn('LedgerQueries.getCallFacts')(function* () {
        const rows = yield* sql.unsafe(SELECT_CALL_FACTS)
        return yield* decodeRows(ledgerCallFactsRowSchema)(rows)
      })

      /** One request-level read unit for view inputs. Materialize all selected
       * rows inside the transaction, then decode after it commits so large
       * schema passes never hold the SQLite transaction open. */
      const getRequestSnapshotData = Effect.fn('LedgerQueries.getRequestSnapshotData')(function* () {
        const rawRows = yield* sql.withTransaction(
          Effect.gen(function* () {
            const sources = yield* sql.unsafe(SELECT_SOURCES)
            const sessions = yield* sql.unsafe(SELECT_SESSIONS)
            const turns = yield* sql.unsafe(SELECT_TURNS)
            const calls = yield* sql.unsafe(SELECT_CALL_FACTS)
            const aliases = yield* sql.unsafe(SELECT_MODEL_ALIASES)
            const overrides = yield* sql.unsafe(SELECT_PRICE_OVERRIDES)
            return { sources, sessions, turns, calls, aliases, overrides }
          }),
        )

        const sources = yield* decodeRows(ledgerSourceRowSchema)(rawRows.sources)
        const sessions = yield* decodeRows(ledgerSessionRowSchema)(rawRows.sessions)
        const turns = yield* decodeRows(ledgerTurnRowSchema)(rawRows.turns)
        const calls = yield* decodeRows(ledgerCallFactsRowSchema)(rawRows.calls)
        const aliases = yield* decodeRows(modelAliasRowSchema)(rawRows.aliases)
        const overrides = yield* decodeRows(priceOverrideRowSchema)(rawRows.overrides)
        return { sources, sessions, turns, calls, aliases, overrides }
      })

      const getCurrencyRate = Effect.fn('LedgerConfig.getCurrencyRate')(function* (code: string) {
        const rows = yield* sql.unsafe('SELECT code, symbol, rate, updated_at FROM currency_rate WHERE code = ?', [
          code,
        ])
        const row = rows[0]
        return row ? yield* Schema.decodeUnknownEffect(currencyRateRowSchema)(row) : null
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
        const parsed = Schema.decodeUnknownResult(ledgerMcpStartupModeSchema)(row?.startup_mode)
        return parsed._tag === 'Success' ? parsed.success : 'on-demand'
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
        getCallFacts,
        getRequestSnapshotData,
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

const ledgerIngestLayer = Layer.effect(
  LedgerIngest,
  Effect.map(LedgerImplementation, implementation =>
    LedgerIngest.of({
      portIn: implementation.portIn,
      deleteSource: implementation.deleteSource,
      clear: implementation.clear,
    }),
  ),
)

const ledgerQueriesLayer = Layer.effect(
  LedgerQueries,
  Effect.map(LedgerImplementation, implementation =>
    LedgerQueries.of({
      getSources: implementation.getSources,
      getSessions: implementation.getSessions,
      getTurns: implementation.getTurns,
      getCalls: implementation.getCalls,
      getCallFacts: implementation.getCallFacts,
      getRequestSnapshotData: implementation.getRequestSnapshotData,
    }),
  ),
)

const ledgerConfigLayer = Layer.effect(
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
  Layer.mergeAll(ledgerIngestLayer, ledgerQueriesLayer, ledgerConfigLayer).pipe(
    Layer.provide(LedgerImplementation.layer),
  )
