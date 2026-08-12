import { z, type ZodRawShape } from 'zod'

import { buildModelsViewFromLedger } from '../../models-view.js'
import { buildOverviewFromLedger, overviewDateRange } from '../../overview.js'
import { buildSessionsViewFromLedger } from '../../sessions-view.js'
import { buildSkillsViewFromLedger } from '../../skills-view.js'
import { queryScope } from '../../store/aggregate.js'
import type { LedgerStore } from '../../store/ledger.js'
import { overviewScopeSchema, type OverviewScope } from '../../../shared/schemas/overview.js'

/**
 * The read-only ledger tools the `watchtower-ledger` MCP server exposes — now
 * built on the SAME aggregation seam and shared zod schemas the UI views
 * consume (ADR 0020, superseding map 53 ticket 55's hand-rolled SQL). The
 * harness agent — Claude Code, OpenCode, Codex, … — calls them exactly like
 * any MCP tool.
 *
 * The server serves the FULL LIFETIME ledger: nothing is baked at spawn, and
 * every tool accepts an optional `scope` argument (the shared
 * `overviewScopeSchema` — period / provider / custom range) so the harness
 * filters autonomously. Omit it and the tool returns the lifetime window;
 * pass it and the payload is computed for exactly that window. The payloads
 * ARE the renderer's own payload types (`OverviewPayload`, `SessionRow[]`,
 * `ModelsPayload`, `SkillsPayload`) — byte-identical shapes, so the agent
 * sees exactly what the UI shows and the renderer's zod schemas double as the
 * MCP contract. Only `ledger_calls` keeps a custom row shape (a drill-down
 * the views don't offer), but it is still fed by the same `queryScope` seam
 * with the UI's query-time display pricing.
 */

/** One tool the SDK registers: name/description + the shared zod input shape
 *  + a run that returns the shared payload object (the server stringifies it). */
export interface LedgerToolDef {
  name: string
  description: string
  inputSchema: ZodRawShape
  run: (args: Record<string, unknown>) => unknown | Promise<unknown>
}

/** The lifetime default: when a tool is called without a `scope` argument it
 *  reports the whole ledger history, exactly like the UI's Lifetime period. */
export const LIFETIME_SCOPE: OverviewScope = { period: 'lifetime' }

/** Resolve a tool call's optional `scope` argument (shared schema, validated)
 *  — absent degrades to the lifetime window. A malformed value degrades the
 *  same way: belt-and-suspenders, because the SDK's zod input schema already
 *  rejects bad args at the protocol boundary (an isError result), so this
 *  only ever fires for direct callers/tests — and dumping lifetime beats
 *  crashing the tool. */
function resolveToolScope(args: Record<string, unknown>): OverviewScope {
  const parsed = overviewScopeSchema.safeParse(args.scope)
  return parsed.success ? parsed.data : LIFETIME_SCOPE
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
export function describeLedgerScope(store: LedgerStore, scope: OverviewScope): {
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
    {
      name: 'ledger_scope',
      description: 'The window a query is scoped to (from the optional `scope` argument; default: the full lifetime ledger), its epoch range, and the counts inside it. Call this first to orient.',
      inputSchema: { scope: overviewScopeSchema.optional() },
      run: (args) => describeLedgerScope(store, resolveToolScope(args)),
    },
    {
      name: 'ledger_overview',
      description: 'The full Overview payload for a window — the same payload the UI dashboard shows: KPIs (cost, calls, sessions, tokens, savings), daily spend, per-model / per-activity / per-tool / per-MCP / per-skill / per-subagent breakdowns, efficiency grade, workflow and unpriced-model facts. Accepts an optional `scope`; default: lifetime.',
      inputSchema: { scope: overviewScopeSchema.optional() },
      run: (args) => buildOverviewFromLedger(store, resolveToolScope(args)),
    },
    {
      name: 'ledger_sessions',
      description: 'Session rows for a window, newest first — the same SessionRow[] the UI Sessions view shows: session id, title, project, provider, models, cost, savings, calls, turns, token buckets, started/ended timestamps. Accepts an optional `scope`; default: lifetime.',
      inputSchema: { scope: overviewScopeSchema.optional() },
      run: (args) => buildSessionsViewFromLedger(store, resolveToolScope(args)),
    },
    {
      name: 'ledger_models',
      description: 'The by-model / by-task / audit report for a window — the same ModelsPayload the UI Models view shows, with the current alias + price-override config applied (query-time pricing). Accepts an optional `scope`; default: lifetime.',
      inputSchema: { scope: overviewScopeSchema.optional() },
      run: (args) => buildModelsViewFromLedger(store, resolveToolScope(args), {
        aliases: store.getModelAliases(),
        overrides: store.getPriceOverrides(),
      }),
    },
    {
      name: 'ledger_skills',
      description: 'The Skills payload for a window — the same SkillsPayload the UI shows: detected skill-candidate drafts (with frequency, spread, cost, sample, evidence sessions), below-gate opportunities, and ghost skills (inventory entries never invoked). This is the suggested-skill pool the chat\'s craft chips surface. Accepts an optional `scope`; default: lifetime.',
      inputSchema: { scope: overviewScopeSchema.optional() },
      run: (args) => buildSkillsViewFromLedger(store, resolveToolScope(args)),
    },
    {
      name: 'ledger_calls',
      description: 'Raw per-call rows for a window, most recent first — a drill-down the UI views do not offer. Optional filters: limit (1-200), scope (period/provider/range — default lifetime), model, project, category, tool (exact tool name). Costs are the UI\'s query-time display cost.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
        scope: overviewScopeSchema.optional(),
        model: z.string().optional(),
        project: z.string().optional(),
        category: z.string().optional(),
        tool: z.string().optional(),
      },
      run: (args) => {
        const limit = typeof args.limit === 'number' ? Math.min(Math.max(Math.floor(args.limit), 1), 200) : 20
        const scope = resolveToolScope(args)
        const model = typeof args.model === 'string' && args.model.length > 0 ? args.model : undefined
        const project = typeof args.project === 'string' && args.project.length > 0 ? args.project : undefined
        const category = typeof args.category === 'string' && args.category.length > 0 ? args.category : undefined
        const tool = typeof args.tool === 'string' && args.tool.length > 0 ? args.tool : undefined

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
            if (category && categoryByTurn.get(`${call.sourceId}\0${call.sessionId}\0${call.turnIndex}`) !== category) return false
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
    },
  ]
}
