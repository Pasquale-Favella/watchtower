import { buildOverviewFromLedger } from '../../overview.js'
import type { LedgerStore } from '../../store/ledger.js'
import type { OverviewScope } from '../../../shared/schemas/overview.js'
import { scopeWindowLabel } from '../prompts.js'
import { describeLedgerScope } from './tools.js'

/**
 * MCP resources for the `watchtower-ledger` server (ADR 0020): read-only
 * documents addressed by URI — the second MCP primitive, alongside tools and
 * prompts. Resources are passive context: a client (or harness agent) reads
 * `ledger://scope` to orient without a tool round-trip, or pulls the raw
 * Overview JSON as a document. Unlike tools they carry no arguments and no
 * execution semantics — just data behind a stable URI.
 *
 * Like the tools, everything here is built on the shared aggregation seam:
 * `ledger://scope` reuses the SAME `describeLedgerScope` the `ledger_scope`
 * tool runs, and `ledger://overview` IS the UI Overview payload. A resource
 * can therefore never drift from what a tool returns or what the UI shows.
 */

/** One resource the SDK registers: a stable URI, metadata, and a read that
 *  returns the document text (the SDK wraps it as text content). */
export interface LedgerResourceDef {
  name: string
  uri: string
  title: string
  description: string
  mimeType: string
  read: () => string
}

export function buildLedgerResources(store: LedgerStore, scope: OverviewScope): LedgerResourceDef[] {
  return [
    {
      name: 'scope',
      uri: 'ledger://scope',
      title: 'Data window',
      description: `The window this server is baked to: ${scopeWindowLabel(scope)}, its epoch range, and the counts inside it. Read this first to orient.`,
      mimeType: 'text/markdown',
      // Computed INSIDE read(), not at build time — the resource must stay as
      // live as the ledger_scope tool it mirrors (a long-lived server could
      // otherwise serve frozen counts).
      read: () => {
        const scopeFacts = describeLedgerScope(store, scope)
        return [
          '# Watchtower data window',
          '',
          `- Window: **${scopeWindowLabel(scope)}**`,
          `- Period: ${scope.period}${scope.range ? ` (custom ${scope.range.since} → ${scope.range.until})` : ''}`,
          `- Epoch range: ${scopeFacts.range.startMs} → ${scopeFacts.range.endMs}`,
          `- Sessions in scope: ${scopeFacts.sessions}`,
          `- Calls in scope: ${scopeFacts.calls}`,
          `- Providers: ${scopeFacts.providers.length ? scopeFacts.providers.join(', ') : '(none)'}`,
          '',
          'Query `ledger_overview` for the full dashboard payload, or `ledger_sessions` / `ledger_models` / `ledger_skills` / `ledger_calls` for drill-downs.',
        ].join('\n')
      },
    },
    {
      name: 'overview',
      uri: 'ledger://overview',
      title: 'Overview payload',
      description: 'The full Overview dashboard payload for the scope, as JSON — the same document the UI Overview view renders.',
      mimeType: 'application/json',
      read: () => JSON.stringify(buildOverviewFromLedger(store, scope), null, 2),
    },
    {
      name: 'schema',
      uri: 'ledger://schema',
      title: 'Ledger schema',
      description: 'The ledger\'s underlying tables and what each MCP tool returns — orienting context before crafting tool calls.',
      mimeType: 'text/markdown',
      // Self-documenting but hand-maintained: keep in sync with
      // buildLedgerTools (tools.ts), this file (resources), and prompts.ts.
      read: () => [
        '# Watchtower ledger schema',
        '',
        '## Tables',
        '- `ledger_source` — one row per discovered provider log file (provider, env fingerprint, path).',
        '- `ledger_session` — one row per coding-agent session (project, working directory, agent type, title).',
        '- `ledger_turn` — one row per user turn (user message, category, sub-category).',
        '- `ledger_call` — one row per model call (model, timestamps, tokens, cost, tools, skills, bash commands, subagents).',
        '',
        '## Tools',
        '- `ledger_scope` — the baked data window + counts (call first to orient).',
        '- `ledger_overview` — the full Overview payload: KPIs, daily spend, per-model / activity / tool / MCP / skill / subagent breakdowns, efficiency.',
        '- `ledger_sessions` — session rows in scope, newest first.',
        '- `ledger_models` — per-model / per-task report with current pricing config.',
        '- `ledger_skills` — skill-candidate drafts, opportunities, ghost skills.',
        '- `ledger_calls` — raw per-call rows (filters: limit, model, project, category, tool).',
        '',
        '## Resources',
        '- `ledger://scope` — the data window (this scope).',
        '- `ledger://overview` — the Overview payload as JSON.',
        '- `ledger://schema` — this document.',
        '',
        '## Prompts',
        '- `coach-orient` — the briefing for a data-grounded coaching turn.',
        '- `build-skill` — the authoring prompt for a detected skill candidate.',
      ].join('\n'),
    },
  ]
}
