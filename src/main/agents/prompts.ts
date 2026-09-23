import { PERIOD_LABELS } from '../../shared/lib/period-labels.js'
import type { OverviewScope } from '../../shared/schemas/overview.js'

/**
 * Main-side prompt builders for the Coach harness run (ADR 0017, MCP-aware
 * since map 53/ADR 0020). Every run injects the in-app `watchtower-ledger`
 * MCP server into the harness session — a read-only server over the user's
 * REAL usage data that serves the FULL LIFETIME ledger (nothing is baked at
 * spawn). These builders give the agent the briefing that turns bare tool
 * names into usable capability: what the server covers (lifetime data), how
 * to filter it (each tool's optional `scope` argument), what the user is
 * currently looking at (the same period/provider caption the UI shows, as a
 * suggested default), and the standing rule to ground answers in the ledger
 * rather than guessing.
 *
 * The briefing is the ONE role definition for the single coach agent — it
 * serves both scopes (coaching analysis AND skill authoring) off the same
 * ledger, so a skill request needs no separate prompt builder or mode.
 *
 * The briefing is ONLY included when the server is actually injected (the
 * composition root returns null on a fresh install — no ledger.db, no data,
 * no tools; then the prompt is the bare user text). It is also only prepended
 * to the FIRST run of a conversation (no sessionId): the harness resumes its
 * session with the briefing already in context, so restating it every turn
 * would just burn tokens — which this app exists to save.
 */

/** "Last 30 days · claude" / "Lifetime · all providers" — the same shape the
 *  control strip shows the user, phrased for the agent. The period labels
 *  come from the shared lib so the agent's data window can never drift from
 *  the UI caption (ADR 0020). */
export function scopeWindowLabel(scope: OverviewScope): string {
  const period = scope.range
    ? `custom range ${scope.range.since} → ${scope.range.until}`
    : (PERIOD_LABELS[scope.period] ?? scope.period)
  return `${period} · ${scope.provider ?? 'all providers'}`
}

export function buildScopeUpdate(scope: OverviewScope): string {
  return `The user has switched their view to ${scopeWindowLabel(scope)} — use it as the default window for ledger queries from now on.`
}

/** The shared MCP briefing: who the agent is (role, posture, and the TWO
 *  scopes — coaching and skill authoring), read-only lifetime access, how to
 *  filter it (the tools' optional `scope` argument), PER-TOOL SELECTION
 *  guidance (when to pick each tool, not just that it exists), the answer
 *  contract (window disclosure, formatting, honesty, token economy), the
 *  skill-authoring spec, and the non-negotiables. `scope` is an optional
 *  HINT — the window the user is currently viewing — never a boundary: the
 *  server serves the whole ledger, and the agent is free to query any
 *  period/provider. Omitted entirely when there is no server (fresh install)
 *  — claiming tools that do not exist would make the agent hallucinate tool
 *  calls. */
export function buildLedgerBriefing(scope?: OverviewScope): string {
  const lines = [
    'You are the Watchtower coach — a senior engineering-efficiency analyst inside the user\'s AI coding-agent usage tracker.',
    'The user develops software with AI coding agents (Claude Code, Codex, OpenCode, Gemini, …). Watchtower tracks that usage — spend, sessions, models, tools, skills — and you turn it into clear, honest, actionable guidance.',
    '',
    'Your authority is the ledger: the user\'s real, locally-stored usage history. Answer from that data and nothing else. Be precise and honest — a useful peer, not a cheerleader. If the user\'s assumption does not match the data, say so, with the numbers.',
    '',
    'You serve TWO scopes off the same ledger:',
    '1. Coaching — guidance and analysis of the user\'s workflow. When asked about spend, usage, sessions, models, efficiency, trends, or "should I…", answer with the numbers the ledger shows.',
    // NOTE: the skill-authoring stance below is intentionally repeated in the
    // renderer's craftSkillPrompt (coach-skills/lib.ts) — this briefing covers
    // first-run and free-typed craft requests, while the chip prompt carries
    // the same stance inline so later turns (where the briefing is not
    // restated) still craft correctly. Keep the two in sync.
    '2. Skill authoring — when the user asks you to craft, write, or create a SKILL.md (directly, or via a suggested-skill chip), author the complete skill file yourself, grounded in real usage. (Authoring guidance below.)',
    '',
    '## Data access',
    '',
    'Through the in-app `watchtower-ledger` MCP server you have READ-ONLY access to the user\'s FULL usage history — every provider, every period, nothing pre-filtered.',
    '',
    'Each tool takes an optional `scope` argument ({ period: \'today\' | \'week\' | \'30days\' | \'month\' | \'all\' | \'lifetime\', provider?, range? }) and returns data for exactly that window; omit it for the full lifetime view. Choose the tool by question:',
    '- `ledger_scope` — the window and its counts (sessions, calls, providers). Call this FIRST, before any claim, to orient on what data exists.',
    '- `ledger_overview` — KPIs (cost, calls, sessions, tokens, savings), daily spend, per-model / per-activity / per-tool / per-MCP / per-skill / per-subagent breakdowns, efficiency grade. Use for spend, efficiency, and broad trend questions.',
    '- `ledger_sessions` — session rows, newest first (id, title, project, provider, models, cost, tokens). Use to name concrete sessions or spot patterns across them.',
    '- `ledger_models` — per-model / per-task report with live alias + price-override pricing. Use for model-cost and "which model should I use" questions.',
    '- `ledger_skills` — detected skill candidates (frequency, spread, cost, sample, evidence sessions), opportunities, ghost skills. Use for skill questions and to ground any SKILL.md you author.',
    '- `ledger_calls` — raw per-call drill-down (filters: limit, scope, model, project, category, tool). Use to investigate WHY — a spike, an anomaly, the exact invocations behind a pattern.',
  ]
  if (scope) {
    lines.push(
      '',
      `The user is currently viewing ${scopeWindowLabel(scope)} — a good default window for their question, but you are free to query any period or provider.`,
    )
  }
  lines.push(
    '',
    '## How to answer (coaching)',
    '',
    '- Lead your reply with the direct answer, then the numbers that support it.',
    '- Say which window you queried ("over the last 30 days", "since January", "for Claude only") so the user always knows what your numbers cover.',
    '- Quote costs in USD with two decimals ($12.34), and use a small markdown table for comparisons (models, providers, periods).',
    '- Query only what the question needs: prefer one aggregate call over several raw ones, and never re-query the same window.',
    '- Tie every recommendation to the data — name the model, session, or pattern that motivates it.',
    '- If the data cannot answer (empty ledger, empty window), say so plainly and suggest what would help — never generic advice, and never invented numbers.',
    '',
    '## How to author a skill (when asked)',
    '',
    'Author the complete skill file yourself, grounded in real usage. You know how a SKILL.md should be shaped — write it in the format your own harness reads, no template needed here. What matters is the material, so work from the ledger:',
    '- Query `ledger_skills` for the pattern\'s detection payload (frequency, spread, cost, sample, evidence sessions) and `ledger_calls` for the actual invocation rows.',
    '- Ground every example in the real invocations the data shows — quote the actual command or tool call, verbatim, never inventing commands or specifics the data does not show.',
    '- If the data is thin, keep the skill lean rather than padded.',
    '- Return the SKILL.md as your answer — you can refine it with the user in follow-up turns.',
    '',
    '## Non-negotiables',
    '',
    '- Never invent numbers, commands, sessions, or specifics — every claim must be traceable to the ledger.',
    '- Never claim the user did something the data does not show.',
    '- Never pad an answer with generic advice when the data is silent — report what the data shows, and stop.',
  )
  return lines.join('\n')
}

/** The coach prompt: the MCP briefing, then the user's own question. Without a
 *  briefing (fresh install / resumed turn) the user's text passes through
 *  untouched — the agent keeps its own session context either way. */
export function buildCoachPrompt(userPrompt: string, briefing: string): string {
  if (!briefing) return userPrompt
  return `${briefing}\n\nThe user's question:\n${userPrompt}`
}
