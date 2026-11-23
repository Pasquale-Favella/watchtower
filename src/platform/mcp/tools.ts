import * as Schema from 'effect/Schema'

import { ledgerMcpCallsToolInputSchema, ledgerMcpScopedToolInputSchema } from '@/shared/rpc/ledger-mcp.js'
import type { OverviewScope } from '@/shared/schemas/overview.js'
import type { LedgerMcpQueries } from '@/platform/mcp/query-api.js'

/** The lifetime default: when a tool is called without a `scope` argument it
 *  reports the whole ledger history, exactly like the UI's Lifetime period. */
export const LIFETIME_SCOPE: OverviewScope = { period: 'lifetime' }

export class LedgerToolInputError extends Schema.TaggedError<LedgerToolInputError>()('LedgerToolInputError', {
  message: Schema.String,
}) {}

/** One tool's Effect Schema is its argument validator and the source for its
 *  advertised JSON Schema. `run` decodes unknown protocol input before calling
 *  the typed implementation, including for direct callers and tests. */
export interface LedgerToolDef {
  name: string
  description: string
  inputSchema: Schema.ConstraintDecoder<unknown>
  run: (args: unknown) => unknown | Promise<unknown>
}

function defineTool<S extends Schema.ConstraintDecoder<unknown>>(
  name: string,
  description: string,
  inputSchema: S,
  run: (args: S['Type']) => unknown | Promise<unknown>,
): LedgerToolDef {
  return {
    name,
    description,
    inputSchema,
    run: args => {
      const decoded = Schema.decodeUnknownResult(inputSchema)(args)
      if (decoded._tag === 'Failure') {
        // Direct callers retain synchronous validation; the SDK maps this error.
        throw new LedgerToolInputError({
          message: `Invalid arguments for tool ${name}`,
        })
      }
      return run(decoded.success)
    },
  }
}

function resolveToolScope(scope: OverviewScope | undefined): OverviewScope {
  return scope ?? LIFETIME_SCOPE
}

export function buildLedgerTools(queries: LedgerMcpQueries, signal?: AbortSignal): LedgerToolDef[] {
  return [
    defineTool(
      'ledger_scope',
      'The window a query is scoped to (from the optional `scope` argument; default: the full lifetime ledger), its epoch range, and the counts inside it. Call this first to orient.',
      ledgerMcpScopedToolInputSchema,
      args => queries.scope(resolveToolScope(args.scope), signal),
    ),
    defineTool(
      'ledger_overview',
      'The full Overview payload for a window — the same payload the UI dashboard shows: KPIs (cost, calls, sessions, tokens, savings), daily spend, per-model / per-activity / per-tool / per-MCP / per-skill / per-subagent breakdowns, efficiency grade, workflow and unpriced-model facts. Accepts an optional `scope`; default: lifetime.',
      ledgerMcpScopedToolInputSchema,
      args => queries.overview(resolveToolScope(args.scope), signal),
    ),
    defineTool(
      'ledger_sessions',
      'Session rows for a window, newest first — the same SessionRow[] the UI Sessions view shows: session id, title, project, provider, models, cost, savings, calls, turns, token buckets, started/ended timestamps. Accepts an optional `scope`; default: lifetime.',
      ledgerMcpScopedToolInputSchema,
      args => queries.sessions(resolveToolScope(args.scope), signal),
    ),
    defineTool(
      'ledger_models',
      'The by-model / by-task / audit report for a window — the same ModelsPayload the UI Models view shows, with the current alias + price-override config applied (query-time pricing). Accepts an optional `scope`; default: lifetime.',
      ledgerMcpScopedToolInputSchema,
      args => queries.models(resolveToolScope(args.scope), signal),
    ),
    defineTool(
      'ledger_skills',
      "The Skills payload for a window — the same SkillsPayload the UI shows: detected skill-candidate drafts (with frequency, spread, cost, sample, evidence sessions), below-gate opportunities, and ghost skills (inventory entries never invoked). This is the suggested-skill pool the chat's craft chips surface. Accepts an optional `scope`; default: lifetime.",
      ledgerMcpScopedToolInputSchema,
      args => queries.skills(resolveToolScope(args.scope), signal),
    ),
    defineTool(
      'ledger_calls',
      "Raw per-call rows for a window, most recent first — a drill-down the UI views do not offer. Optional filters: limit (1-200), scope (period/provider/range — default lifetime), model, project, category, tool (exact tool name). Costs are the UI's query-time display cost.",
      ledgerMcpCallsToolInputSchema,
      args =>
        queries.calls(
          {
            scope: resolveToolScope(args.scope),
            limit: args.limit ?? 20,
            ...(args.model && args.model.length > 0 ? { model: args.model } : {}),
            ...(args.project && args.project.length > 0 ? { project: args.project } : {}),
            ...(args.category && args.category.length > 0 ? { category: args.category } : {}),
            ...(args.tool && args.tool.length > 0 ? { tool: args.tool } : {}),
          },
          signal,
        ),
    ),
  ]
}
