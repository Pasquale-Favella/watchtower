import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/sql/SqlClient'
import { SqlError } from 'effect/sql/SqlError'

import { type LedgerExportData, ledgerExportDataSchema } from './export-read-projections.js'
import { LedgerExportReads } from './ledger-export-reads.js'
import { SELECT_VIEW_ALIASES, SELECT_VIEW_OVERRIDES } from './ledger-view-reads-live.js'

const SELECT_EXPORT_SESSIONS = `
  SELECT s.source_id AS sourceId, s.session_id AS sessionId, s.project AS project,
         s.project_path AS projectPath, s.working_directory AS workingDirectory,
         s.canonical_project AS canonicalProject, s.canonical_cwd AS canonicalCwd,
         COALESCE(source.provider, 'unknown') AS sourceProvider, source.repo_url AS repoUrl
  FROM ledger_session AS s LEFT JOIN ledger_source AS source ON source.id = s.source_id
  ORDER BY s.session_id ASC, s.rowid ASC
`

const SELECT_EXPORT_TURNS = `
  SELECT source_id AS sourceId, session_id AS sessionId, turn_index AS turnIndex,
         timestamp, category
  FROM ledger_turn ORDER BY session_id ASC, turn_index ASC, rowid ASC
`

const SELECT_EXPORT_CALLS = `
  SELECT source_id AS sourceId, session_id AS sessionId, turn_index AS turnIndex,
         call_index AS callIndex, provider, model, timestamp, speed,
         base_cost_usd AS baseCostUSD, savings_usd AS savingsUSD,
         input_tokens AS inputTokens, output_tokens AS outputTokens,
         cache_creation_input_tokens AS cacheCreationInputTokens,
         cache_read_input_tokens AS cacheReadInputTokens, cached_input_tokens AS cachedInputTokens,
         web_search_requests AS webSearchRequests, reasoning_tokens AS reasoningTokens,
         tools_json AS tools, mcp_tools_json AS mcpTools, bash_commands_json AS bashCommands
  FROM ledger_call ORDER BY session_id ASC, turn_index ASC, call_index ASC, rowid ASC
`

export const LedgerExportReadsLive = Layer.effect(
  LedgerExportReads,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const getExportData = Effect.fn('LedgerExportReads.getExportData')(function* (): Effect.fn.Return<
      LedgerExportData,
      SqlError | Schema.SchemaError
    > {
      const rawRows = yield* sql.withTransaction(
        Effect.gen(function* () {
          const sessions = yield* sql.unsafe(SELECT_EXPORT_SESSIONS)
          const turns = yield* sql.unsafe(SELECT_EXPORT_TURNS)
          const calls = yield* sql.unsafe(SELECT_EXPORT_CALLS)
          const aliases = yield* sql.unsafe(SELECT_VIEW_ALIASES)
          const overrides = yield* sql.unsafe(SELECT_VIEW_OVERRIDES)
          return { sessions, turns, calls, aliases, overrides }
        }),
      )

      return yield* Schema.decodeUnknownEffect(ledgerExportDataSchema)(rawRows)
    })
    return LedgerExportReads.of({
      getExportData,
    })
  }),
)
