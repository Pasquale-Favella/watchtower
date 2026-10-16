import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import { SqlError } from 'effect/sql/SqlError'

import { LedgerViewReads } from './ledger-view-reads.js'
import { type OverviewReadData, overviewReadDataSchema } from './overview-read-projections.js'
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

    const getOverviewData = Effect.fn('LedgerViewReads.getOverviewData')(function* (): Effect.fn.Return<
      OverviewReadData,
      SqlError | Schema.SchemaError
    > {
      const rawRows = yield* sql.withTransaction(
        Effect.gen(function* () {
          const sessions = yield* sql.unsafe(SELECT_OVERVIEW_SESSIONS)
          const turns = yield* sql.unsafe(SELECT_OVERVIEW_TURNS)
          const calls = yield* sql.unsafe(SELECT_OVERVIEW_CALLS)
          const aliases = yield* sql.unsafe(SELECT_VIEW_ALIASES)
          const overrides = yield* sql.unsafe(SELECT_VIEW_OVERRIDES)
          return { sessions, turns, calls, aliases, overrides }
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
