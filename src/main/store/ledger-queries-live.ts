import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/sql/SqlClient'

import {
  ledgerCallRowSchema,
  ledgerSessionRowSchema,
  ledgerSourceRowSchema,
  ledgerTurnRowSchema,
  modelAliasRowSchema,
  priceOverrideRowSchema,
} from '../../shared/schemas/ledger.js'
import { SELECT_MODEL_ALIASES, SELECT_PRICE_OVERRIDES } from './ledger-config-live.js'
import { LedgerQueries } from './ledger-ports.js'
import { decodeRows } from './ledger-repository-codec.js'
import { ledgerCallFactsRowSchema } from './read-projections.js'

const SELECT_SOURCES = `
  SELECT id, provider, env_fingerprint, file_path, repo_url, project,
         CAST(fingerprint_dev AS TEXT) AS fingerprint_dev,
         CAST(fingerprint_ino AS TEXT) AS fingerprint_ino,
         fingerprint_mtime_ms, fingerprint_size_bytes, last_ported_at
  FROM ledger_source ORDER BY id ASC
`

const SELECT_HAS_SOURCES = 'SELECT 1 FROM ledger_source LIMIT 1'

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

export const LedgerQueriesLive = Layer.effect(
  LedgerQueries,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const getSources = Effect.fn('LedgerQueries.getSources')(function* () {
      const rows = yield* sql.unsafe(SELECT_SOURCES)
      return yield* decodeRows(ledgerSourceRowSchema)(rows)
    })

    const hasSources = Effect.fn('LedgerQueries.hasSources')(function* () {
      const rows = yield* sql.unsafe(SELECT_HAS_SOURCES)
      return rows.length > 0
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
    return LedgerQueries.of({
      getSources,
      hasSources,
      getSessions,
      getTurns,
      getCalls,
      getCallFacts,
      getRequestSnapshotData,
    })
  }),
)
