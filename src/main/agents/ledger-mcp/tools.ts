import * as Schema from 'effect/Schema'

import { type OverviewScope, overviewScopeSchema } from '../../../shared/schemas/overview.js'
import type { LedgerMcpQueries } from './query-api.js'

/** The lifetime default: when a tool is called without a `scope` argument it
 *  reports the whole ledger history, exactly like the UI's Lifetime period. */
export const LIFETIME_SCOPE: OverviewScope = { period: 'lifetime' }

// The shared scope contract accepts an explicit `undefined` on its optional
// fields for in-process callers. JSON has no undefined value, so derive the
// MCP wire projection with exact optional keys while reusing those same field
// schemas. This keeps generated JSON Schema aligned with the MCP decoder.
const scopeInputSchema = overviewScopeSchema.mapFields(fields => ({
  ...fields,
  provider: Schema.optionalKey(Schema.required(Schema.readonlyKey(fields.provider))),
  range: Schema.optionalKey(Schema.required(Schema.readonlyKey(fields.range))),
}))

const scopedToolInputSchema = Schema.Struct({ scope: Schema.optionalKey(scopeInputSchema) })

const callsInputSchema = Schema.Struct({
  limit: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200))),
  scope: Schema.optionalKey(scopeInputSchema),
  model: Schema.optionalKey(Schema.String),
  project: Schema.optionalKey(Schema.String),
  category: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.String),
})

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

export function buildLedgerTools(queries: LedgerMcpQueries): LedgerToolDef[] {
  return [
    defineTool(
      'ledger_scope',
      'The window a query is scoped to (from the optional `scope` argument; default: the full lifetime ledger), its epoch range, and the counts inside it. Call this first to orient.',
      scopedToolInputSchema,
      args => queries.scope(resolveToolScope(args.scope)),
    ),
    defineTool(
      'ledger_overview',
      'The full Overview payload for a window — the same payload the UI dashboard shows: KPIs (cost, calls, sessions, tokens, savings), daily spend, per-model / per-activity / per-tool / per-MCP / per-skill / per-subagent breakdowns, efficiency grade, workflow and unpriced-model facts. Accepts an optional `scope`; default: lifetime.',
      scopedToolInputSchema,
      args => queries.overview(resolveToolScope(args.scope)),
    ),
    defineTool(
      'ledger_sessions',
      'Session rows for a window, newest first — the same SessionRow[] the UI Sessions view shows: session id, title, project, provider, models, cost, savings, calls, turns, token buckets, started/ended timestamps. Accepts an optional `scope`; default: lifetime.',
      scopedToolInputSchema,
      args => queries.sessions(resolveToolScope(args.scope)),
    ),
    defineTool(
      'ledger_models',
      'The by-model / by-task / audit report for a window — the same ModelsPayload the UI Models view shows, with the current alias + price-override config applied (query-time pricing). Accepts an optional `scope`; default: lifetime.',
      scopedToolInputSchema,
      args => queries.models(resolveToolScope(args.scope)),
    ),
    defineTool(
      'ledger_skills',
      "The Skills payload for a window — the same SkillsPayload the UI shows: detected skill-candidate drafts (with frequency, spread, cost, sample, evidence sessions), below-gate opportunities, and ghost skills (inventory entries never invoked). This is the suggested-skill pool the chat's craft chips surface. Accepts an optional `scope`; default: lifetime.",
      scopedToolInputSchema,
      args => queries.skills(resolveToolScope(args.scope)),
    ),
    defineTool(
      'ledger_calls',
      "Raw per-call rows for a window, most recent first — a drill-down the UI views do not offer. Optional filters: limit (1-200), scope (period/provider/range — default lifetime), model, project, category, tool (exact tool name). Costs are the UI's query-time display cost.",
      callsInputSchema,
      args =>
        queries.calls({
          scope: resolveToolScope(args.scope),
          limit: args.limit ?? 20,
          ...(args.model && args.model.length > 0 ? { model: args.model } : {}),
          ...(args.project && args.project.length > 0 ? { project: args.project } : {}),
          ...(args.category && args.category.length > 0 ? { category: args.category } : {}),
          ...(args.tool && args.tool.length > 0 ? { tool: args.tool } : {}),
        }),
    ),
  ]
}
