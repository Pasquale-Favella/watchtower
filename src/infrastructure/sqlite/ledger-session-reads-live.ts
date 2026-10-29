import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/sql/SqlClient'

import {
  ledgerSessionRowSchema,
  ledgerSourceRowSchema,
  ledgerTurnRowSchema,
  modelAliasRowSchema,
  priceOverrideRowSchema,
} from '../../shared/schemas/ledger.js'
import { SELECT_MODEL_ALIASES, SELECT_PRICE_OVERRIDES } from './ledger-config-live.js'
import { decodeRows } from './ledger-repository-codec.js'
import { LedgerSessionReads } from '../../core/ports/ledger-session-reads.js'
import { ledgerCallFactsRowSchema } from '../../core/analytics/projections/read-projections.js'
import {
  sessionSearchCallSchema,
  sessionSearchSessionSchema,
  sessionSearchTurnSchema,
  sessionSummaryCallSchema,
  sessionSummarySessionSchema,
  sessionSummaryTurnSchema,
} from '../../core/analytics/projections/session-read-projections.js'

// Project/session list inputs deliberately exclude transcript text and the
// large tools/inventory/PR JSON columns. Each fixed SELECT is materialized in
// one transaction with its current alias/override config where pricing needs it.
// The explicit rowid suffix preserves stable insertion traversal for duplicate
// public session IDs.
const SELECT_SESSION_SUMMARY_SESSIONS = `
  SELECT s.source_id AS sourceId, s.session_id AS sessionId, s.project AS project,
         s.project_path AS projectPath, s.working_directory AS workingDirectory,
         s.canonical_project AS canonicalProject, s.canonical_cwd AS canonicalCwd,
         s.title AS title, source.provider AS sourceProvider, source.repo_url AS repoUrl
  FROM ledger_session AS s LEFT JOIN ledger_source AS source ON source.id = s.source_id
  ORDER BY s.session_id ASC, s.rowid ASC
`

const SELECT_SESSION_SUMMARY_TURNS = `
  SELECT source_id AS sourceId, session_id AS sessionId, turn_index AS turnIndex, timestamp
  FROM ledger_turn ORDER BY session_id ASC, turn_index ASC, rowid ASC
`

const SELECT_SESSION_SUMMARY_CALLS = `
  SELECT source_id AS sourceId, session_id AS sessionId, turn_index AS turnIndex,
         call_index AS callIndex, provider, model, timestamp, speed, base_cost_usd AS baseCostUSD,
         savings_usd AS savingsUSD, input_tokens AS inputTokens,
         output_tokens AS outputTokens, cache_creation_input_tokens AS cacheCreationInputTokens,
         cache_read_input_tokens AS cacheReadInputTokens, cached_input_tokens AS cachedInputTokens,
         web_search_requests AS webSearchRequests
  FROM ledger_call ORDER BY session_id ASC, turn_index ASC, call_index ASC, rowid ASC
`

const SELECT_SESSION_SEARCH_SESSIONS = `
  SELECT s.source_id AS sourceId, s.session_id AS sessionId, s.project AS project,
         s.project_path AS projectPath, s.working_directory AS workingDirectory,
         s.canonical_project AS canonicalProject, s.canonical_cwd AS canonicalCwd,
         source.provider AS sourceProvider
  FROM ledger_session AS s LEFT JOIN ledger_source AS source ON source.id = s.source_id
  ORDER BY s.session_id ASC, s.rowid ASC
`

const SELECT_SESSION_SEARCH_TURNS = `
  SELECT source_id AS sourceId, session_id AS sessionId, turn_index AS turnIndex,
         timestamp, COALESCE(user_message, '') AS userMessage
  FROM ledger_turn ORDER BY session_id ASC, turn_index ASC, rowid ASC
`

const SELECT_SESSION_SEARCH_CALLS = `
  SELECT source_id AS sourceId, session_id AS sessionId, turn_index AS turnIndex,
         call_index AS callIndex, provider, model, timestamp, bash_commands_json AS bashCommands
  FROM ledger_call ORDER BY session_id ASC, turn_index ASC, call_index ASC, rowid ASC
`

const SELECT_DETAIL_SOURCES = `
  SELECT id, provider, env_fingerprint, file_path, repo_url, project,
         CAST(fingerprint_dev AS TEXT) AS fingerprint_dev,
         CAST(fingerprint_ino AS TEXT) AS fingerprint_ino,
         fingerprint_mtime_ms, fingerprint_size_bytes, last_ported_at
  FROM ledger_source
  WHERE id IN (SELECT source_id FROM ledger_session WHERE session_id = ?)
  ORDER BY id ASC
`

const SELECT_DETAIL_SESSIONS = `
  SELECT source_id, session_id, project, project_path, working_directory, canonical_project, canonical_cwd,
         agent_type, title, pr_links_json, is_sidechain, parent_session_id, agent_spawn_links_json,
         mcp_inventory_json, ambiguous_spawn_agent_ids_json, ever_had_branch
  FROM ledger_session WHERE session_id = ? ORDER BY session_id ASC, rowid ASC
`

const SELECT_DETAIL_TURNS = `
  SELECT source_id, session_id, turn_index, timestamp, user_message, git_branch, pr_refs_json,
         spawn_tool_use_ids_json, category, sub_category, retries, has_edits
  FROM ledger_turn WHERE session_id = ? ORDER BY session_id ASC, turn_index ASC, rowid ASC
`

const SELECT_DETAIL_CALL_FACTS = `
  SELECT source_id, session_id, turn_index, call_index, dedup_key, provider, model, timestamp, speed,
         project, working_directory, base_cost_usd, is_estimated, savings_usd, savings_baseline_model,
         input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cached_input_tokens,
         reasoning_tokens, web_search_requests, cache_creation_one_hour_tokens,
         tools_json, mcp_tools_json, skills_json, subagent_types_json, bash_commands_json, tool_sequence_json
  FROM ledger_call WHERE session_id = ? ORDER BY session_id ASC, turn_index ASC, call_index ASC, rowid ASC
`

export const LedgerSessionReadsLive = Layer.effect(
  LedgerSessionReads,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const getSessionSummaryData = Effect.fn('LedgerSessionReads.getSessionSummaryData')(function* () {
      const rawRows = yield* sql.withTransaction(
        Effect.gen(function* () {
          const sessions = yield* sql.unsafe(SELECT_SESSION_SUMMARY_SESSIONS)
          const turns = yield* sql.unsafe(SELECT_SESSION_SUMMARY_TURNS)
          const calls = yield* sql.unsafe(SELECT_SESSION_SUMMARY_CALLS)
          const aliases = yield* sql.unsafe(SELECT_MODEL_ALIASES)
          const overrides = yield* sql.unsafe(SELECT_PRICE_OVERRIDES)
          return { sessions, turns, calls, aliases, overrides }
        }),
      )
      const sessions = yield* decodeRows(sessionSummarySessionSchema)(rawRows.sessions)
      const turns = yield* decodeRows(sessionSummaryTurnSchema)(rawRows.turns)
      const calls = yield* decodeRows(sessionSummaryCallSchema)(rawRows.calls)
      const aliases = yield* decodeRows(modelAliasRowSchema)(rawRows.aliases)
      const overrides = yield* decodeRows(priceOverrideRowSchema)(rawRows.overrides)
      return { sessions, turns, calls, aliases, overrides }
    })

    const getSessionDetailData = Effect.fn('LedgerSessionReads.getSessionDetailData')(function* (
      publicSessionId: string,
      sourceId?: number,
    ) {
      const params = sourceId === undefined ? [publicSessionId] : [publicSessionId, sourceId]
      const sourceFilter = sourceId === undefined ? '' : ' AND source_id = ?'
      const scoped = (statement: string): string => statement.replace('session_id = ?', `session_id = ?${sourceFilter}`)
      const rawRows = yield* sql.withTransaction(
        Effect.gen(function* () {
          const sources = yield* sql.unsafe(scoped(SELECT_DETAIL_SOURCES), params)
          const sessions = yield* sql.unsafe(scoped(SELECT_DETAIL_SESSIONS), params)
          const turns = yield* sql.unsafe(scoped(SELECT_DETAIL_TURNS), params)
          const calls = yield* sql.unsafe(scoped(SELECT_DETAIL_CALL_FACTS), params)
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

    const getSessionSearchData = Effect.fn('LedgerSessionReads.getSessionSearchData')(function* () {
      const rawRows = yield* sql.withTransaction(
        Effect.gen(function* () {
          const sessions = yield* sql.unsafe(SELECT_SESSION_SEARCH_SESSIONS)
          const turns = yield* sql.unsafe(SELECT_SESSION_SEARCH_TURNS)
          const calls = yield* sql.unsafe(SELECT_SESSION_SEARCH_CALLS)
          const aliases = yield* sql.unsafe(SELECT_MODEL_ALIASES)
          return { sessions, turns, calls, aliases }
        }),
      )
      const sessions = yield* decodeRows(sessionSearchSessionSchema)(rawRows.sessions)
      const turns = yield* decodeRows(sessionSearchTurnSchema)(rawRows.turns)
      const calls = yield* decodeRows(sessionSearchCallSchema)(rawRows.calls)
      const aliases = yield* decodeRows(modelAliasRowSchema)(rawRows.aliases)
      return { sessions, turns, calls, aliases }
    })
    return LedgerSessionReads.of({
      getSessionSummaryData,
      getSessionDetailData,
      getSessionSearchData,
    })
  }),
)
