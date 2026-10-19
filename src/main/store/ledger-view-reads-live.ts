import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import { SqlError } from 'effect/sql/SqlError'

import type { DateRange } from '../pipeline/types.js'
import { LedgerViewReads } from './ledger-view-reads.js'
import { type OverviewReadData, overviewReadDataSchema } from './overview-read-projections.js'
import { candidateTimestampBounds } from './scoped-snapshot-sql.js'
import { type LedgerViewData, ledgerViewDataSchema } from './view-read-projections.js'

const SELECT_VIEW_SESSIONS = `
  SELECT s.source_id AS sourceId, s.session_id AS sessionId, s.project AS project,
         s.project_path AS projectPath, s.working_directory AS workingDirectory,
         s.canonical_project AS canonicalProject, s.canonical_cwd AS canonicalCwd,
         COALESCE(source.provider, 'unknown') AS sourceProvider
  FROM ledger_session AS s LEFT JOIN ledger_source AS source ON source.id = s.source_id
  ORDER BY s.session_id ASC, s.rowid ASC
`

const SELECT_VIEW_TURNS = `
  SELECT source_id AS sourceId, session_id AS sessionId, turn_index AS turnIndex,
         timestamp, category, sub_category AS subCategory
  FROM ledger_turn ORDER BY session_id ASC, turn_index ASC, rowid ASC
`

const SELECT_VIEW_CALLS = `
  SELECT source_id AS sourceId, session_id AS sessionId, turn_index AS turnIndex,
         call_index AS callIndex, provider, model, timestamp, speed,
         base_cost_usd AS baseCostUSD, savings_usd AS savingsUSD, is_estimated AS isEstimated,
         input_tokens AS inputTokens, output_tokens AS outputTokens,
         cache_creation_input_tokens AS cacheCreationInputTokens,
         cache_read_input_tokens AS cacheReadInputTokens, cached_input_tokens AS cachedInputTokens,
         web_search_requests AS webSearchRequests, reasoning_tokens AS reasoningTokens,
         subagent_types_json AS subagentTypes
  FROM ledger_call ORDER BY session_id ASC, turn_index ASC, call_index ASC, rowid ASC
`

export const SELECT_VIEW_ALIASES = 'SELECT model, alias_of AS aliasOf FROM model_alias'

export const SELECT_VIEW_OVERRIDES = `
  SELECT model, input_price_per_million AS inputPricePerMillion,
         output_price_per_million AS outputPricePerMillion
  FROM price_override
`

const SELECT_OVERVIEW_SESSIONS = `
  SELECT s.source_id AS sourceId, s.session_id AS sessionId,
         source.provider AS sourceProvider
  FROM ledger_session AS s LEFT JOIN ledger_source AS source ON source.id = s.source_id
  ORDER BY s.session_id ASC, s.rowid ASC
`

const SELECT_OVERVIEW_TURNS = `
  SELECT source_id AS sourceId, session_id AS sessionId, turn_index AS turnIndex,
         timestamp, COALESCE(user_message, '') AS userMessage, category,
         sub_category AS subCategory, retries, has_edits AS hasEdits
  FROM ledger_turn ORDER BY session_id ASC, turn_index ASC, rowid ASC
`

const SELECT_OVERVIEW_CALLS = `
  SELECT source_id AS sourceId, session_id AS sessionId, turn_index AS turnIndex,
         call_index AS callIndex, provider, model, timestamp, speed,
         base_cost_usd AS baseCostUSD, is_estimated AS isEstimated,
         savings_usd AS savingsUSD, savings_baseline_model AS savingsBaselineModel,
         input_tokens AS inputTokens, output_tokens AS outputTokens,
         cache_creation_input_tokens AS cacheCreationInputTokens,
         cache_read_input_tokens AS cacheReadInputTokens, cached_input_tokens AS cachedInputTokens,
         web_search_requests AS webSearchRequests,
         tools_json AS tools, mcp_tools_json AS mcpTools,
         subagent_types_json AS subagentTypes,
         tool_sequence_json AS toolSequence
  FROM ledger_call ORDER BY session_id ASC, turn_index ASC, call_index ASC, rowid ASC
`

const scopedOverviewSessions = `
  WITH scoped AS (
    SELECT DISTINCT source_id, session_id
    FROM ledger_call
    WHERE timestamp >= ? AND timestamp <= ?
  )
  SELECT s.source_id AS sourceId, s.session_id AS sessionId,
         source.provider AS sourceProvider
  FROM scoped AS sc
  JOIN ledger_session AS s ON s.source_id = sc.source_id AND s.session_id = sc.session_id
  LEFT JOIN ledger_source AS source ON source.id = s.source_id
  ORDER BY s.session_id ASC, s.rowid ASC
`

const scopedOverviewTurns = `
  WITH scoped AS (
    SELECT DISTINCT source_id, session_id
    FROM ledger_call
    WHERE timestamp >= ? AND timestamp <= ?
  )
  SELECT t.source_id AS sourceId, t.session_id AS sessionId, t.turn_index AS turnIndex,
         t.timestamp, COALESCE(t.user_message, '') AS userMessage, t.category,
         t.sub_category AS subCategory, t.retries, t.has_edits AS hasEdits
  FROM scoped AS sc
  JOIN ledger_turn AS t ON t.source_id = sc.source_id AND t.session_id = sc.session_id
  ORDER BY t.session_id ASC, t.turn_index ASC, t.rowid ASC
`

const scopedOverviewCalls = `
  WITH scoped AS (
    SELECT DISTINCT source_id, session_id
    FROM ledger_call
    WHERE timestamp >= ? AND timestamp <= ?
  )
  SELECT c.source_id AS sourceId, c.session_id AS sessionId, c.turn_index AS turnIndex,
         c.call_index AS callIndex, c.provider, c.model, c.timestamp, c.speed,
         c.base_cost_usd AS baseCostUSD, c.is_estimated AS isEstimated,
         c.savings_usd AS savingsUSD, c.savings_baseline_model AS savingsBaselineModel,
         c.input_tokens AS inputTokens, c.output_tokens AS outputTokens,
         c.cache_creation_input_tokens AS cacheCreationInputTokens,
         c.cache_read_input_tokens AS cacheReadInputTokens, c.cached_input_tokens AS cachedInputTokens,
         c.web_search_requests AS webSearchRequests,
         c.tools_json AS tools, c.mcp_tools_json AS mcpTools,
         c.subagent_types_json AS subagentTypes,
         c.tool_sequence_json AS toolSequence
  FROM scoped AS sc
  JOIN ledger_call AS c ON c.source_id = sc.source_id AND c.session_id = sc.session_id
  ORDER BY c.session_id ASC, c.turn_index ASC, c.call_index ASC, c.rowid ASC
`

const SELECT_OVERVIEW_DATA_START_CALLS = `
  SELECT MIN(timestamp) AS firstTimestamp FROM ledger_call WHERE timestamp <> ''
`
const SELECT_OVERVIEW_DATA_START_TURNS = `
  SELECT MIN(timestamp) AS firstTimestamp FROM ledger_turn WHERE timestamp <> ''
`
const SELECT_OVERVIEW_MODELS = 'SELECT DISTINCT model FROM ledger_call ORDER BY model ASC'

export const LedgerViewReadsLive = Layer.effect(
  LedgerViewReads,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const getViewData = Effect.fn('LedgerViewReads.getViewData')(function* (): Effect.fn.Return<
      LedgerViewData,
      SqlError | Schema.SchemaError
    > {
      const rawRows = yield* sql.withTransaction(
        Effect.gen(function* () {
          const sessions = yield* sql.unsafe(SELECT_VIEW_SESSIONS)
          const turns = yield* sql.unsafe(SELECT_VIEW_TURNS)
          const calls = yield* sql.unsafe(SELECT_VIEW_CALLS)
          const aliases = yield* sql.unsafe(SELECT_VIEW_ALIASES)
          const overrides = yield* sql.unsafe(SELECT_VIEW_OVERRIDES)
          return { sessions, turns, calls, aliases, overrides }
        }),
      )

      return yield* Schema.decodeUnknownEffect(ledgerViewDataSchema)(rawRows)
    })

    const getOverviewData = Effect.fn('LedgerViewReads.getOverviewData')(function* (
      range?: DateRange,
    ): Effect.fn.Return<OverviewReadData, SqlError | Schema.SchemaError> {
      const rawRows = yield* sql.withTransaction(
        Effect.gen(function* () {
          const params = range === undefined ? undefined : candidateTimestampBounds(range)
          const sessions = params
            ? yield* sql.unsafe(scopedOverviewSessions, params)
            : yield* sql.unsafe(SELECT_OVERVIEW_SESSIONS)
          const turns = params
            ? yield* sql.unsafe(scopedOverviewTurns, params)
            : yield* sql.unsafe(SELECT_OVERVIEW_TURNS)
          const calls = params
            ? yield* sql.unsafe(scopedOverviewCalls, params)
            : yield* sql.unsafe(SELECT_OVERVIEW_CALLS)
          const aliases = yield* sql.unsafe(SELECT_VIEW_ALIASES)
          const overrides = yield* sql.unsafe(SELECT_VIEW_OVERRIDES)
          const callMinRows = yield* sql.unsafe(SELECT_OVERVIEW_DATA_START_CALLS)
          const callMin = (callMinRows[0] as { firstTimestamp: string | null } | undefined)?.firstTimestamp ?? null
          const dataStartTimestamp = callMin
            ? callMin
            : ((
                (yield* sql.unsafe(SELECT_OVERVIEW_DATA_START_TURNS))[0] as
                  { firstTimestamp: string | null } | undefined
              )?.firstTimestamp ?? null)
          const models = yield* sql.unsafe(SELECT_OVERVIEW_MODELS)
          return {
            sessions,
            turns,
            calls,
            aliases,
            overrides,
            lifetime: { dataStartTimestamp, models: models.map(row => (row as { model: string }).model) },
          }
        }),
      )

      return yield* Schema.decodeUnknownEffect(overviewReadDataSchema)(rawRows)
    })
    return LedgerViewReads.of({
      getViewData,
      getOverviewData,
    })
  }),
)
