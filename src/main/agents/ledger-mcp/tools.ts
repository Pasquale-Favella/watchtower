import * as Schema from 'effect/Schema'

import { type OverviewScope, overviewScopeSchema } from '../../../shared/schemas/overview.js'
import { buildModelsViewFromLedger } from '../../models-view.js'
import { buildOverviewFromLedger, overviewDateRange } from '../../overview.js'
import { buildSessionsViewFromLedger } from '../../sessions-view.js'
import { buildSkillsViewFromLedger } from '../../skills-view.js'
import { queryScope } from '../../store/aggregate.js'
import type { LedgerStore } from '../../store/ledger.js'

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
      // The SDK handler converts this validation failure into an isError tool result.
      // eslint-disable-next-line no-restricted-syntax
      if (decoded._tag === 'Failure') throw new Error(`Invalid arguments for tool ${name}`)
      return run(decoded.success)
    },
  }
}

function resolveToolScope(scope: OverviewScope | undefined): OverviewScope {
  return scope ?? LIFETIME_SCOPE
}

/** The scope's concrete epoch range + a per-call-timestamp predicate. The seam
 *  (`queryScope`) filters by provider only — the range applies at the assembly
 *  layer (turn-in-range), so raw-call tools apply it themselves. */
function scopeRange(scope: OverviewScope): {
  range: { startMs: number; endMs: number }
  inRange: (timestamp: string) => boolean
} {
  const range = overviewDateRange(scope)
  const startMs = range.start.getTime()
  const endMs = range.end.getTime()
  return {
    range: { startMs, endMs },
    inRange: timestamp => {
      const ms = new Date(timestamp).getTime()
      return !Number.isNaN(ms) && ms >= startMs && ms <= endMs
    },
  }
}

/** A scope's concrete facts: the window itself, its epoch range, and the
 *  in-window counts (sessions/calls/providers). Shared by the `ledger_scope`
 *  tool AND the `ledger://scope` resource (ADR 0020) — one computation, two
 *  MCP surfaces, so the resource can never drift from the tool. */
export function describeLedgerScope(
  store: LedgerStore,
  scope: OverviewScope,
): {
  scope: OverviewScope
  range: { startMs: number; endMs: number }
  sessions: number
  calls: number
  providers: string[]
} {
  const { range, inRange } = scopeRange(scope)
  const data = queryScope(store, { range: overviewDateRange(scope), provider: scope.provider })
  const calls = data.calls.filter(call => inRange(call.timestamp))
  const inScopeSessions = new Set(calls.map(call => `${call.sourceId}\0${call.sessionId}`))
  return {
    scope,
    range,
    sessions: data.sessions.filter(session => inScopeSessions.has(`${session.sourceId}\0${session.sessionId}`)).length,
    calls: calls.length,
    providers: [...new Set(calls.map(call => call.provider))].sort(),
  }
}

export function buildLedgerTools(store: LedgerStore): LedgerToolDef[] {
  return [
    defineTool(
      'ledger_scope',
      'The window a query is scoped to (from the optional `scope` argument; default: the full lifetime ledger), its epoch range, and the counts inside it. Call this first to orient.',
      scopedToolInputSchema,
      args => describeLedgerScope(store, resolveToolScope(args.scope)),
    ),
    defineTool(
      'ledger_overview',
      'The full Overview payload for a window — the same payload the UI dashboard shows: KPIs (cost, calls, sessions, tokens, savings), daily spend, per-model / per-activity / per-tool / per-MCP / per-skill / per-subagent breakdowns, efficiency grade, workflow and unpriced-model facts. Accepts an optional `scope`; default: lifetime.',
      scopedToolInputSchema,
      args => buildOverviewFromLedger(store, resolveToolScope(args.scope)),
    ),
    defineTool(
      'ledger_sessions',
      'Session rows for a window, newest first — the same SessionRow[] the UI Sessions view shows: session id, title, project, provider, models, cost, savings, calls, turns, token buckets, started/ended timestamps. Accepts an optional `scope`; default: lifetime.',
      scopedToolInputSchema,
      args => buildSessionsViewFromLedger(store, resolveToolScope(args.scope)),
    ),
    defineTool(
      'ledger_models',
      'The by-model / by-task / audit report for a window — the same ModelsPayload the UI Models view shows, with the current alias + price-override config applied (query-time pricing). Accepts an optional `scope`; default: lifetime.',
      scopedToolInputSchema,
      args =>
        buildModelsViewFromLedger(store, resolveToolScope(args.scope), {
          aliases: store.getModelAliases(),
          overrides: store.getPriceOverrides(),
        }),
    ),
    defineTool(
      'ledger_skills',
      "The Skills payload for a window — the same SkillsPayload the UI shows: detected skill-candidate drafts (with frequency, spread, cost, sample, evidence sessions), below-gate opportunities, and ghost skills (inventory entries never invoked). This is the suggested-skill pool the chat's craft chips surface. Accepts an optional `scope`; default: lifetime.",
      scopedToolInputSchema,
      args => buildSkillsViewFromLedger(store, resolveToolScope(args.scope)),
    ),
    defineTool(
      'ledger_calls',
      "Raw per-call rows for a window, most recent first — a drill-down the UI views do not offer. Optional filters: limit (1-200), scope (period/provider/range — default lifetime), model, project, category, tool (exact tool name). Costs are the UI's query-time display cost.",
      callsInputSchema,
      args => {
        const limit = args.limit ?? 20
        const scope = resolveToolScope(args.scope)
        const model = args.model && args.model.length > 0 ? args.model : undefined
        const project = args.project && args.project.length > 0 ? args.project : undefined
        const category = args.category && args.category.length > 0 ? args.category : undefined
        const tool = args.tool && args.tool.length > 0 ? args.tool : undefined

        const { inRange } = scopeRange(scope)
        const data = queryScope(store, { range: overviewDateRange(scope), provider: scope.provider })
        const categoryByTurn = new Map<string, string>()
        for (const turn of data.turns) {
          categoryByTurn.set(`${turn.sourceId}\0${turn.sessionId}\0${turn.turnIndex}`, turn.category)
        }
        const rows = data.calls
          .filter(call => {
            if (!inRange(call.timestamp)) return false
            if (model && call.resolvedModel !== model && call.model !== model) return false
            if (project && call.project !== project) return false
            if (category && categoryByTurn.get(`${call.sourceId}\0${call.sessionId}\0${call.turnIndex}`) !== category)
              return false
            if (tool && !call.tools.includes(tool)) return false
            return true
          })
          .sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0))
          .slice(0, limit)
        return rows.map(call => ({
          timestamp: call.timestamp,
          provider: call.provider,
          model: call.resolvedModel,
          project: call.project ?? null,
          working_directory: call.workingDirectory ?? null,
          display_cost_usd: call.displayCostUSD,
          savings_usd: call.savingsUSD,
          estimated: call.isEstimated === 1,
          tokens: {
            input: call.inputTokens,
            output: call.outputTokens,
            cache_read: call.cacheReadInputTokens,
            cache_write: call.cacheCreationInputTokens,
            reasoning: call.reasoningTokens,
          },
          tools: call.tools,
          skills: call.skills,
          bash_commands: call.bashCommands,
          subagents: call.subagentTypes,
        }))
      },
    ),
  ]
}
