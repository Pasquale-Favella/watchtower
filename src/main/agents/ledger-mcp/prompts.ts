import type { ZodRawShape } from 'zod'

import { buildLedgerBriefing } from '../prompts.js'

/**
 * MCP prompt templates for the `watchtower-ledger` server (ADR 0020): reusable
 * prompt PREAMBLES the agent or user can invoke by name — the third MCP
 * primitive alongside tools and resources. Unlike tools (model-driven) these
 * are pre-shaped context the caller selects, so they are the natural home for
 * the coach briefing.
 *
 * The template reuses the SAME main-side builder the Coach runner uses
 * (`buildLedgerBriefing`), so a prompt served over MCP is byte-identical to
 * the briefing a `coach:run` would send — no drift between the two surfaces.
 * The briefing carries the agent's TWO-scope role (coaching + skill
 * authoring), so there is no separate `build-skill` prompt anymore — a skill
 * request is a coaching question the briefing already answers.
 */

/** One prompt template the SDK registers: name/description + the shared zod
 *  input shape + a render that returns the user-facing text (the SDK wraps it
 *  in a single user message). */
export interface LedgerPromptDef {
  name: string
  title: string
  description: string
  argsSchema: ZodRawShape
  render: (args: Record<string, unknown>) => string
}

export function buildLedgerPrompts(): LedgerPromptDef[] {
  // The server serves the full lifetime ledger (no spawn-time scope), so the
  // briefing describes the lifetime window and the tools' optional `scope`
  // argument. Note this briefing deliberately carries NO user-window hint
  // (unlike the `coach:run` briefing, which renders the current UI scope):
  // the MCP server is session-independent and cannot know the window — this
  // asymmetry is what keeps the server free of per-conversation state.
  const briefing = buildLedgerBriefing()
  return [
    {
      name: 'coach-orient',
      title: 'Orient the coach on the current data window',
      description:
        'The MCP briefing for a coaching turn: the two scopes (coaching analysis + skill authoring), what the ledger tools are, the baked data window, and the ground-your-answer rule. The natural opening for any data-grounded coaching question.',
      argsSchema: {},
      render: () =>
        [
          briefing,
          '',
          'Orient with `ledger_scope` FIRST — know the window and its counts before you claim anything — then query the tools the question demands. Ground every number in the ledger and state the window your answer covers.',
        ].join('\n'),
    },
  ]
}
