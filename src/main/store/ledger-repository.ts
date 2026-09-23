import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { SqlError } from 'effect/unstable/sql/SqlError'

import type { CurrencyRate, PortResult, PriceOverride } from '../../shared/schemas/ledger.js'
import type { LedgerMcpStartupMode } from '../../shared/schemas/ledger-mcp.js'
import type { SkillsDismissal } from '../../shared/schemas/skills.js'
import { mapFileToLedgerRows, type PortInput } from './port.js'

type SourceInput = ReturnType<typeof mapFileToLedgerRows>['source']
type RunResult = { changes: number | bigint; lastInsertRowid: number | bigint }

export class LedgerRepository extends Context.Service<
  LedgerRepository,
  {
    portIn(input: PortInput): Effect.Effect<PortResult, SqlError>
    clear(): Effect.Effect<void, SqlError>
    deleteSource(provider: string, envFingerprint: string, filePath: string): Effect.Effect<void, SqlError>
    setModelAlias(model: string, aliasOf: string): Effect.Effect<void, SqlError>
    removeModelAlias(model: string): Effect.Effect<void, SqlError>
    setPriceOverride(model: string, override: Omit<PriceOverride, 'model'>): Effect.Effect<void, SqlError>
    removePriceOverride(model: string): Effect.Effect<void, SqlError>
    setCurrencyRate(rate: CurrencyRate): Effect.Effect<void, SqlError>
    setDisplayCurrency(code: string): Effect.Effect<void, SqlError>
    setRefreshCadence(value: string): Effect.Effect<void, SqlError>
    setLedgerMcpStartupMode(mode: LedgerMcpStartupMode): Effect.Effect<void, SqlError>
    dismissSkill(
      source: SkillsDismissal['source'],
      name: string,
      reason: string,
      created: string,
    ): Effect.Effect<void, SqlError>
  }
>()('watchtower/store/LedgerRepository') {
  static readonly layer = Layer.effect(
    LedgerRepository,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const setModelAlias = Effect.fn('LedgerRepository.setModelAlias')(function* (model: string, aliasOf: string) {
        yield* sql.unsafe(
          'INSERT INTO model_alias (model, alias_of) VALUES (?, ?) ON CONFLICT(model) DO UPDATE SET alias_of = excluded.alias_of',
          [model, aliasOf],
        )
      })

      const removeModelAlias = Effect.fn('LedgerRepository.removeModelAlias')(function* (model: string) {
        yield* sql.unsafe('DELETE FROM model_alias WHERE model = ?', [model])
      })

      const setPriceOverride = Effect.fn('LedgerRepository.setPriceOverride')(function* (
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

      const removePriceOverride = Effect.fn('LedgerRepository.removePriceOverride')(function* (model: string) {
        yield* sql.unsafe('DELETE FROM price_override WHERE model = ?', [model])
      })

      const setCurrencyRate = Effect.fn('LedgerRepository.setCurrencyRate')(function* (rate: CurrencyRate) {
        yield* sql.unsafe(
          `
          INSERT INTO currency_rate (code, symbol, rate, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(code) DO UPDATE SET symbol = excluded.symbol, rate = excluded.rate, updated_at = excluded.updated_at
        `,
          [rate.code, rate.symbol, rate.rate, rate.updatedAt],
        )
      })

      const setDisplayCurrency = Effect.fn('LedgerRepository.setDisplayCurrency')(function* (code: string) {
        yield* sql.unsafe(
          `
          INSERT INTO display_currency_config (id, code) VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET code = excluded.code
        `,
          [code],
        )
      })

      const setRefreshCadence = Effect.fn('LedgerRepository.setRefreshCadence')(function* (value: string) {
        yield* sql.unsafe(
          `
          INSERT INTO refresh_cadence_config (id, value) VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET value = excluded.value
        `,
          [value],
        )
      })

      const setLedgerMcpStartupMode = Effect.fn('LedgerRepository.setLedgerMcpStartupMode')(function* (
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

      const dismissSkill = Effect.fn('LedgerRepository.dismissSkill')(function* (
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

      const deleteSource = Effect.fn('LedgerRepository.deleteSource')(function* (
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

      const clear = Effect.fn('LedgerRepository.clear')(function* (): Effect.fn.Return<void, SqlError> {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql.unsafe('DELETE FROM ledger_call')
            yield* sql.unsafe('DELETE FROM ledger_turn')
            yield* sql.unsafe('DELETE FROM ledger_session')
            yield* sql.unsafe('DELETE FROM ledger_source')
          }),
        )
      })

      const portIn = Effect.fn('LedgerRepository.portIn')(function* (
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

      return LedgerRepository.of({
        portIn,
        clear,
        deleteSource,
        setModelAlias,
        removeModelAlias,
        setPriceOverride,
        removePriceOverride,
        setCurrencyRate,
        setDisplayCurrency,
        setRefreshCadence,
        setLedgerMcpStartupMode,
        dismissSkill,
      })
    }),
  )
}
