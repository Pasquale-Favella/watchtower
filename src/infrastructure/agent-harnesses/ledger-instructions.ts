import {
  hasOrchestratorEndpoint,
  type OrchestrationHarness,
  orchestrationInstructions,
} from '@/infrastructure/agent-harnesses/orchestration-instructions.js'

/** The server name every harness registers the read-only usage ledger endpoint under. */
export const LEDGER_MCP_SERVER = 'watchtower-ledger'

/** The ledger MCP's read-only tools, without their `ledger_` prefix. */
export const LEDGER_TOOLS = ['scope', 'overview', 'sessions', 'models', 'skills', 'calls'] as const

/**
 * How each harness reaches the tools. Claude and Codex defer MCP tools out of the list the model reads, so the
 * guidance names the callable form, and for Claude how to load it.
 */
const ACCESS = {
  claude: `Ledger tools are \`mcp__${LEDGER_MCP_SERVER}__ledger_*\`. If they are not loaded, load them first with ToolSearch \`select:${LEDGER_TOOLS.map(tool => `mcp__${LEDGER_MCP_SERVER}__ledger_${tool}`).join(',')}\`.`,
  codex:
    'Ledger tools are `mcp__watchtower_ledger__ledger_*`, inside `exec` as `tools.mcp__watchtower_ledger__ledger_*`. They can be missing from the tools listed to you and are still callable.',
  acp: `Ledger tools are \`ledger_*\` on the \`${LEDGER_MCP_SERVER}\` MCP server; your harness may prefix them with that server name. If they are not in your tool list, search your tools for "ledger" before you say they are missing.`,
} as const satisfies Record<OrchestrationHarness, string>

/** The coaching and skill-authoring guidance a run reads once when the ledger endpoint is attached. */
export function ledgerInstructions(harness: OrchestrationHarness): string {
  return `## Watchtower usage ledger

When the user asks about their AI coding-agent usage (spend, sessions, models, tools, skills), you are their engineering-efficiency coach: a senior analyst and an honest peer, not a cheerleader. The ledger is their real, locally stored usage history and your only authority on it; if an assumption does not match the data, say so with the numbers. ${ACCESS[harness]}

- The tools are READ-ONLY and stateless. Each takes an optional \`scope\` ({ period: 'today' | 'week' | '30days' | 'month' | 'all' | 'lifetime', provider?, range? }): use the window the user names, otherwise omit it for the full lifetime.
- Pick by question. \`ledger_scope\` first, to see what data exists. \`ledger_overview\`: KPIs, daily spend, per model, activity, tool, MCP, skill and subagent breakdowns, efficiency grade. \`ledger_sessions\`: session rows, newest first. \`ledger_models\`: per model and task report with live pricing. \`ledger_skills\`: skill candidates, opportunities, ghost skills. \`ledger_calls\`: raw call rows (filters: limit, scope, model, project, category, tool) to find why.
- Coaching: lead with the direct answer, then the numbers, and say which window they cover. Costs in USD with two decimals ($12.34); a small markdown table for comparisons. Prefer one aggregate call over several raw ones and never re-query a window. Tie each recommendation to the model, session or pattern behind it. If the data cannot answer, say so and suggest what would help.
- Skill authoring: when asked to craft a SKILL.md, write the complete file yourself in the format your harness reads, grounded in \`ledger_skills\` (frequency, spread, cost, sample, evidence sessions) and \`ledger_calls\` (the actual invocations). Quote the real command or tool call verbatim; if the data is thin, keep the skill lean. Return the SKILL.md as your answer and refine it in follow-ups.
- Never invent numbers, commands or sessions, never claim the user did what the data does not show, and never pad with generic advice when the data is silent.`
}

/** Whether the ledger endpoint is among an Agent Run's attached endpoints. */
export function hasLedgerEndpoint(endpoints: ReadonlyArray<{ readonly name: string }> | undefined): boolean {
  return endpoints?.some(endpoint => endpoint.name === LEDGER_MCP_SERVER) ?? false
}

/**
 * Every guidance block the attached endpoints call for, in a fixed order: ledger, then delegation. Undefined when
 * no such endpoint is attached.
 */
export function endpointInstructions(
  harness: OrchestrationHarness,
  endpoints: ReadonlyArray<{ readonly name: string }> | undefined,
): string | undefined {
  const blocks = [
    ...(hasLedgerEndpoint(endpoints) ? [ledgerInstructions(harness)] : []),
    ...(hasOrchestratorEndpoint(endpoints) ? [orchestrationInstructions(harness)] : []),
  ]
  return blocks.length > 0 ? blocks.join('\n\n') : undefined
}

/** ACP has no system field, so the guidance rides ahead of the first prompt of a session. */
export function withAcpInstructions(prompt: string, instructions: string): string {
  return `<watchtower_instructions>\n${instructions}\n</watchtower_instructions>\n\n<user_request>\n${prompt}\n</user_request>`
}
