import { z, type ZodRawShape } from 'zod'

import { buildModelsViewFromLedger } from '../../models-view.js'
import { buildOverviewFromLedger, overviewDateRange } from '../../overview.js'
import { buildSessionsViewFromLedger } from '../../sessions-view.js'
import { buildSkillsViewFromLedger } from '../../skills-view.js'
import { queryScope } from '../../store/aggregate.js'
import type { LedgerStore } from '../../store/ledger.js'
import type { OverviewScope } from '../../../shared/schemas/overview.js'

/**
 * The read-only ledger tools the `watchtower-ledger` MCP server exposes — now
 * built on the SAME aggregation seam and shared zod schemas the UI views
 * consume (ADR 0020, superseding map 53 ticket 55's hand-rolled SQL). The
 * harness agent — Claude Code, OpenCode, Codex, … — calls them exactly like
 * any MCP tool; every one is filtered to the SCOPE baked at spawn (the
 * conversation's snapshot of the current UI scope), and the payloads ARE the
 * renderer's own payload types (`OverviewPayload`, `SessionRow[]`,
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

/** The scope's concrete facts: the baked UI scope, its epoch range, and the
 *  in-scope counts (sessions/calls/providers). Shared by the `ledger_scope`
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

export function buildLedgerTools(store: LedgerStore, scope: OverviewScope): LedgerToolDef[] {
  return [
    {
      name: 'ledger_scope',
      description: 'The window this server is baked to: the current UI scope (period / provider / custom range), its epoch range, and the counts inside it. Call this first to orient.',
      inputSchema: {},
      run: () => describeLedgerScope(store, scope),
    },
    {
      name: 'ledger_overview',
      description: 'The full Overview payload for the scope — the same payload the UI dashboard shows: KPIs (cost, calls, sessions, tokens, savings), daily spend, per-model / per-activity / per-tool / per-MCP / per-skill / per-subagent breakdowns, efficiency grade, workflow and unpriced-model facts.',
      inputSchema: {},
      run: () => buildOverviewFromLedger(store, scope),
    },
    {
      name: 'ledger_sessions',
      description: 'Session rows inside the scope, newest first — the same SessionRow[] the UI Sessions view shows: session id, title, project, provider, models, cost, savings, calls, turns, token buckets, started/ended timestamps.',
      inputSchema: {},
      run: () => buildSessionsViewFromLedger(store, scope),
    },
    {
      name: 'ledger_models',
      description: 'The by-model / by-task / audit report for the scope — the same ModelsPayload the UI Models view shows, with the current alias + price-override config applied (query-time pricing).',
      inputSchema: {},
      run: () => buildModelsViewFromLedger(store, scope, {
        aliases: store.getModelAliases(),
        overrides: store.getPriceOverrides(),
      }),
    },
    {
      name: 'ledger_skills',
      description: 'The Skills payload for the scope — the same SkillsPayload the UI Skills view shows: detected skill-candidate drafts (with frequency, spread, cost, sample, evidence sessions), below-gate opportunities, and ghost skills (inventory entries never invoked). This is the build-skill flow\'s candidate pool.',
      inputSchema: {},
      run: () => buildSkillsViewFromLedger(store, scope),
    },
    {
      name: 'ledger_calls',
      description: 'Raw per-call rows inside the scope, most recent first — a drill-down the UI views do not offer. Optional filters: limit (1-200), model, project, category, tool (exact tool name). Costs are the UI\'s query-time display cost.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional(),
        model: z.string().optional(),
        project: z.string().optional(),
        category: z.string().optional(),
        tool: z.string().optional(),
      },
      run: (args) => {
        const limit = typeof args.limit === 'number' ? Math.min(Math.max(Math.floor(args.limit), 1), 200) : 20
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
