import { scopeWindowLabel } from '../prompts.js'
import type { LedgerMcpQueries } from './query-api.js'
import { LIFETIME_SCOPE } from './tools.js'

/** MCP resources are read-only documents. Query-backed resources read current
 *  ledger state on every request, so a long-lived server never serves stale
 *  counts or an old overview payload. */
export interface LedgerResourceDef {
  name: string
  uri: string
  title: string
  description: string
  mimeType: string
  read: () => string | Promise<string>
}

export function buildLedgerResources(queries: LedgerMcpQueries): LedgerResourceDef[] {
  return [
    {
      name: 'scope',
      uri: 'ledger://scope',
      title: 'Data window',
      description: `The full lifetime data window the server serves: ${scopeWindowLabel(LIFETIME_SCOPE)}, its epoch range, and the counts inside it. Read this first to orient; per-window queries go through each tool's optional scope argument.`,
      mimeType: 'text/markdown',
      read: async () => {
        const scopeFacts = await queries.scope(LIFETIME_SCOPE)
        return [
          '# Watchtower data window',
          '',
          `- Window: **${scopeWindowLabel(LIFETIME_SCOPE)}**`,
          `- Period: ${LIFETIME_SCOPE.period}`,
          `- Epoch range: ${scopeFacts.range.startMs} → ${scopeFacts.range.endMs}`,
          `- Sessions: ${scopeFacts.sessions}`,
          `- Calls: ${scopeFacts.calls}`,
          `- Providers: ${scopeFacts.providers.length ? scopeFacts.providers.join(', ') : '(none)'}`,
          '',
          'The tools accept an optional `scope` argument ({ period, provider?, range? }) to query a specific window; omit it for this full lifetime view. Query `ledger_overview` for the dashboard payload, or `ledger_sessions` / `ledger_models` / `ledger_skills` / `ledger_calls` for drill-downs.',
        ].join('\n')
      },
    },
    {
      name: 'overview',
      uri: 'ledger://overview',
      title: 'Overview payload',
      description:
        'The full lifetime Overview dashboard payload, as JSON — the same document the UI Overview view renders for the Lifetime period.',
      mimeType: 'application/json',
      read: async () => JSON.stringify(await queries.overview(LIFETIME_SCOPE), null, 2),
    },
    {
      name: 'schema',
      uri: 'ledger://schema',
      title: 'Ledger schema',
      description:
        "The ledger's underlying tables and what each MCP tool returns — orienting context before crafting tool calls.",
      mimeType: 'text/markdown',
      // Keep this static document aligned with buildLedgerTools and prompts.ts.
      read: () =>
        [
          '# Watchtower ledger schema',
          '',
          'The server serves the FULL lifetime ledger; every tool takes an optional `scope` argument ({ period: today|week|30days|month|all|lifetime, provider?, range? }) and defaults to lifetime when it is omitted.',
          '',
          '## Tables',
          '- `ledger_source` — one row per discovered provider log file (provider, env fingerprint, path).',
          '- `ledger_session` — one row per coding-agent session (project, working directory, agent type, title).',
          '- `ledger_turn` — one row per user turn (user message, category, sub-category).',
          '- `ledger_call` — one row per model call (model, timestamps, tokens, cost, tools, skills, bash commands, subagents).',
          '',
          '## Tools',
          '- `ledger_scope` — the window of a query (optional scope; default lifetime) + counts (call first to orient).',
          '- `ledger_overview` — the full Overview payload: KPIs, daily spend, per-model / activity / tool / MCP / skill / subagent breakdowns, efficiency.',
          '- `ledger_sessions` — session rows for a window, newest first.',
          '- `ledger_models` — per-model / per-task report with current pricing config.',
          '- `ledger_skills` — skill-candidate drafts, opportunities, ghost skills.',
          '- `ledger_calls` — raw per-call rows (filters: limit, scope, model, project, category, tool).',
          '',
          '## Resources',
          '- `ledger://scope` — the full lifetime data window.',
          '- `ledger://overview` — the lifetime Overview payload as JSON.',
          '- `ledger://schema` — this document.',
          '',
          '## Prompts',
          '- `coach-orient` — the dual-scope briefing for a data-grounded coaching turn (analysis + skill authoring).',
        ].join('\n'),
    },
  ]
}
