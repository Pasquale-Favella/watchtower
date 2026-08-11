import { PERIOD_LABELS } from '../../shared/lib/period-labels.js'
import type { OverviewScope } from '../../shared/schemas/overview.js'
import type { SkillsProseRequest } from '../../shared/schemas/skills.js'

/**
 * Main-side prompt builders for the Coach & Skills harness runs (ADR 0017,
 * MCP-aware since map 53/ADR 0020). Every run injects the in-app
 * `watchtower-ledger` MCP server into the harness session — a read-only,
 * scope-baked window over the user's REAL usage data. These builders give the
 * agent the briefing that turns bare tool names into usable capability: what
 * the data window is (the same period/provider caption the UI shows), which
 * tools exist and what each returns, and the standing rule to ground answers
 * in the ledger rather than guessing.
 *
 * The briefing is ONLY included when the server is actually injected (the
 * composition root returns null on a fresh install — no ledger.db, no data,
 * no tools; then the prompt is the bare user/evidence text). It is also only
 * prepended to the FIRST run of a conversation (no sessionId): the harness
 * resumes its session with the briefing already in context, so restating it
 * every turn would just burn tokens — which this app exists to save.
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

/** The shared MCP briefing: read-only access, the data window, the six tools,
 *  and the ground-your-answer rule. Omitted entirely when there is no server
 *  (fresh install) — claiming tools that do not exist would make the agent
 *  hallucinate tool calls. */
export function buildLedgerBriefing(scope: OverviewScope): string {
  return [
    'You are running inside Watchtower, the user\'s AI coding-agent usage tracker.',
    '',
    `Through the in-app \`watchtower-ledger\` MCP server you have READ-ONLY access to the user's real usage data, scoped to the current window: ${scopeWindowLabel(scope)}.`,
    '',
    'The server exposes six tools:',
    '- `ledger_scope` — the baked data window and its counts. Call this FIRST to orient.',
    '- `ledger_overview` — the Overview dashboard payload: KPIs (cost, calls, sessions, tokens, savings), daily spend, per-model / per-activity / per-tool / per-MCP / per-skill / per-subagent breakdowns, efficiency grade.',
    '- `ledger_sessions` — session rows (id, title, project, provider, models, cost, tokens), newest first.',
    '- `ledger_models` — per-model / per-task report with the current alias + price-override pricing applied.',
    '- `ledger_skills` — detected skill candidates (frequency, spread, cost, sample, evidence sessions), opportunities, ghost skills.',
    '- `ledger_calls` — raw per-call drill-down with optional filters (limit, model, project, category, tool).',
    '',
    'Ground your answer in this data: when asked about spend, sessions, models, skills, or trends, query the ledger instead of guessing. Never invent numbers or claim facts the data does not show.',
  ].join('\n')
}

/** The coach prompt: the MCP briefing, then the user's own question. Without a
 *  briefing (fresh install / resumed turn) the user's text passes through
 *  untouched — the agent keeps its own session context either way. */
export function buildCoachPrompt(userPrompt: string, briefing: string): string {
  if (!briefing) return userPrompt
  return `${briefing}\n\nThe user's question:\n${userPrompt}`
}

/** The harness prompt for a build-skill run: the briefing (when injected),
 *  then the NORMALIZED evidence — pattern key, counts, spread. Deliberately
 *  excludes `sample` (a raw command line) and all session text from the
 *  prompt itself; the ledger tools may be consulted for real grounding, but
 *  the draft must never invent raw transcripts or prompts. */
export function buildProsePrompt(evidence: SkillsProseRequest, briefing: string): string {
  const lines = [
    'You are authoring a skill file for the user\'s coding-agent workflow.',
    'Write a concise SKILL.md draft from the normalized evidence below — never invent raw transcripts or prompts.',
  ]
  if (briefing) {
    lines.push(
      '',
      'The in-app `watchtower-ledger` MCP server is available and you SHOULD use it to ground the draft in real usage: `ledger_scope` to orient, `ledger_skills` for this candidate\'s real detection payload (frequency, spread, cost, and its sample evidence), and `ledger_calls` for real invocation rows to build a factual Example. Use real data where available; never invent specifics the data does not support.',
    )
  }
  lines.push(
    '',
    `Pattern: ${evidence.name}`,
    `Source: ${evidence.source}`,
    `Frequency: ${evidence.frequency} occurrences`,
    `Spread: ${evidence.spreadSessions} session(s) / ${evidence.spreadProjects} project(s)`,
    `Cost: ${evidence.costUSD.toFixed(2)} USD across ${evidence.turns} turn(s)`,
    '',
    'Return only the markdown: a # name heading, a ## Description, a ## When to use, and a ## Example built from the evidence. Keep it under 40 lines.',
  )
  return lines.join('\n')
}
