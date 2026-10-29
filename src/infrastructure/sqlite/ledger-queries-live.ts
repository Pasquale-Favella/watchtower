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
import type { DateRange } from '../../core/domain/observations/types.js'
import { SELECT_MODEL_ALIASES, SELECT_PRICE_OVERRIDES } from './ledger-config-live.js'
import { LedgerQueries } from '../../core/ports/repository.js'
import { decodeRows } from './ledger-repository-codec.js'
import {
  ledgerCallDiagnosticsRowSchema,
  ledgerCallFactsRowSchema,
  ledgerLifetimeModelSchema,
} from '../../core/analytics/projections/read-projections.js'
import { candidateTimestampBounds, selectScopedSessionRows } from './scoped-snapshot-sql.js'

const SELECT_SOURCES = `
  SELECT id, provider, env_fingerprint, file_path, repo_url, project,
         CAST(fingerprint_dev AS TEXT) AS fingerprint_dev,
         CAST(fingerprint_ino AS TEXT) AS fingerprint_ino,
         fingerprint_mtime_ms, fingerprint_size_bytes, last_ported_at
  FROM ledger_source ORDER BY id ASC
`

const SELECT_HAS_SOURCES = 'SELECT 1 FROM ledger_source LIMIT 1'

const SESSION_COLUMNS = [
  'source_id',
  'session_id',
  'project',
  'project_path',
  'working_directory',
  'canonical_project',
  'canonical_cwd',
  'agent_type',
  'title',
  'pr_links_json',
  'is_sidechain',
  'parent_session_id',
  'agent_spawn_links_json',
  'mcp_inventory_json',
  'ambiguous_spawn_agent_ids_json',
  'ever_had_branch',
] as const

const TURN_COLUMNS = [
  'source_id',
  'session_id',
  'turn_index',
  'timestamp',
  'user_message',
  'git_branch',
  'pr_refs_json',
  'spawn_tool_use_ids_json',
  'category',
  'sub_category',
  'retries',
  'has_edits',
] as const

const CALL_COLUMNS = [
  'source_id',
  'session_id',
  'turn_index',
  'call_index',
  'call_key',
  'dedup_key',
  'provider',
  'model',
  'timestamp',
  'speed',
  'project',
  'project_path',
  'working_directory',
  'base_cost_usd',
  'is_estimated',
  'savings_usd',
  'savings_baseline_model',
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'cached_input_tokens',
  'reasoning_tokens',
  'web_search_requests',
  'cache_creation_one_hour_tokens',
  'agent_type',
  'tools_json',
  'mcp_tools_json',
  'skills_json',
  'subagent_types_json',
  'bash_commands_json',
  'tool_sequence_json',
  'loc_added',
  'loc_removed',
  'interrupted',
  'user_modified',
  'tool_errors',
  'edit_failed',
] as const

const CALL_FACT_COLUMNS = [
  'source_id',
  'session_id',
  'turn_index',
  'call_index',
  'dedup_key',
  'provider',
  'model',
  'timestamp',
  'speed',
  'project',
  'working_directory',
  'base_cost_usd',
  'is_estimated',
  'savings_usd',
  'savings_baseline_model',
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'cached_input_tokens',
  'reasoning_tokens',
  'web_search_requests',
  'cache_creation_one_hour_tokens',
  'tools_json',
  'mcp_tools_json',
  'skills_json',
  'subagent_types_json',
  'bash_commands_json',
  'tool_sequence_json',
] as const

const SELECT_SESSIONS = `SELECT ${SESSION_COLUMNS.join(', ')} FROM ledger_session`
const SELECT_TURNS = `SELECT ${TURN_COLUMNS.join(', ')} FROM ledger_turn`
const SELECT_CALLS = `SELECT ${CALL_COLUMNS.join(', ')} FROM ledger_call`
const SELECT_CALL_FACTS = `SELECT ${CALL_FACT_COLUMNS.join(', ')} FROM ledger_call`
const CALL_DIAGNOSTIC_COLUMNS = [
  'source_id',
  'session_id',
  'turn_index',
  'call_index',
  'interrupted',
  'user_modified',
  'tool_errors',
  'edit_failed',
] as const

const ORDER_SESSIONS = ' ORDER BY session_id ASC, rowid ASC'
const ORDER_TURNS = ' ORDER BY session_id ASC, turn_index ASC, rowid ASC'
const ORDER_CALLS = ' ORDER BY session_id ASC, turn_index ASC, call_index ASC, rowid ASC'
const ORDER_SCOPED_SESSIONS = ' ORDER BY facts.session_id ASC, __rowid ASC'
const ORDER_SCOPED_TURNS = ' ORDER BY facts.session_id ASC, facts.turn_index ASC, __rowid ASC'
const ORDER_SCOPED_CALLS = ' ORDER BY facts.session_id ASC, facts.turn_index ASC, facts.call_index ASC, __rowid ASC'

const SELECT_LIFETIME_MODELS = `
  SELECT DISTINCT source_id AS sourceId, model
  FROM ledger_call
  ORDER BY source_id ASC, model ASC
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
      const rows = yield* sql.unsafe(SELECT_SESSIONS + ORDER_SESSIONS)
      return yield* decodeRows(ledgerSessionRowSchema)(rows)
    })

    const getTurns = Effect.fn('LedgerQueries.getTurns')(function* () {
      const rows = yield* sql.unsafe(SELECT_TURNS + ORDER_TURNS)
      return yield* decodeRows(ledgerTurnRowSchema)(rows)
    })

    const getCalls = Effect.fn('LedgerQueries.getCalls')(function* () {
      const rows = yield* sql.unsafe(SELECT_CALLS + ORDER_CALLS)
      return yield* decodeRows(ledgerCallRowSchema)(rows)
    })

    /** The same rows, shaped to what the query-time aggregation seam reads:
     *  29 of `getCalls`'s 38 columns, in the same order, over the same index
     *  path. The nine it drops have no reader anywhere in `src/platform/electron/main` — the
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
      const rows = yield* sql.unsafe(SELECT_CALL_FACTS + ORDER_CALLS)
      return yield* decodeRows(ledgerCallFactsRowSchema)(rows)
    })

    /** One request-level read unit for view inputs. Materialize all selected
     * rows inside the transaction, then decode after it commits so large
     * schema passes never hold the SQLite transaction open. */
    const getRequestSnapshotData = Effect.fn('LedgerQueries.getRequestSnapshotData')(function* (
      range?: DateRange,
      includeCallDiagnostics = false,
    ) {
      const bounded = range !== undefined
      const [since, until] = bounded ? candidateTimestampBounds(range) : ['', '']
      const sessionsQuery = bounded
        ? selectScopedSessionRows(SESSION_COLUMNS, 'ledger_session') + ORDER_SCOPED_SESSIONS
        : SELECT_SESSIONS + ORDER_SESSIONS
      const turnsQuery = bounded
        ? selectScopedSessionRows(TURN_COLUMNS, 'ledger_turn') + ORDER_SCOPED_TURNS
        : SELECT_TURNS + ORDER_TURNS
      const callsQuery = bounded
        ? selectScopedSessionRows(CALL_FACT_COLUMNS, 'ledger_call') + ORDER_SCOPED_CALLS
        : SELECT_CALL_FACTS + ORDER_CALLS
      const params = bounded ? [since, until] : []
      const diagnosticsQuery = bounded
        ? selectScopedSessionRows(CALL_DIAGNOSTIC_COLUMNS, 'ledger_call') + ORDER_SCOPED_CALLS
        : `SELECT ${CALL_DIAGNOSTIC_COLUMNS.join(', ')} FROM ledger_call` + ORDER_CALLS
      const rawRows = yield* sql.withTransaction(
        Effect.gen(function* () {
          const sources = yield* sql.unsafe(SELECT_SOURCES)
          const sessions = yield* sql.unsafe(sessionsQuery, params)
          const turns = yield* sql.unsafe(turnsQuery, params)
          const calls = yield* sql.unsafe(callsQuery, params)
          const callDiagnostics = includeCallDiagnostics ? yield* sql.unsafe(diagnosticsQuery, params) : undefined
          const lifetimeModels = bounded ? yield* sql.unsafe(SELECT_LIFETIME_MODELS) : []
          const aliases = yield* sql.unsafe(SELECT_MODEL_ALIASES)
          const overrides = yield* sql.unsafe(SELECT_PRICE_OVERRIDES)
          return { sources, sessions, turns, calls, callDiagnostics, lifetimeModels, aliases, overrides }
        }),
      )

      const sources = yield* decodeRows(ledgerSourceRowSchema)(rawRows.sources)
      const sessions = yield* decodeRows(ledgerSessionRowSchema)(rawRows.sessions)
      const turns = yield* decodeRows(ledgerTurnRowSchema)(rawRows.turns)
      const calls = yield* decodeRows(ledgerCallFactsRowSchema)(rawRows.calls)
      const callDiagnostics = rawRows.callDiagnostics
        ? yield* decodeRows(ledgerCallDiagnosticsRowSchema)(rawRows.callDiagnostics)
        : undefined
      const lifetimeModels = bounded ? yield* decodeRows(ledgerLifetimeModelSchema)(rawRows.lifetimeModels) : undefined
      const aliases = yield* decodeRows(modelAliasRowSchema)(rawRows.aliases)
      const overrides = yield* decodeRows(priceOverrideRowSchema)(rawRows.overrides)
      return {
        sources,
        sessions,
        turns,
        calls,
        aliases,
        overrides,
        ...(callDiagnostics ? { callDiagnostics } : {}),
        ...(lifetimeModels ? { lifetimeModels } : {}),
      }
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
