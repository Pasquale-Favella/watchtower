import { buildLedgerBriefing } from '../prompts.js'

/** One zero-argument prompt template the SDK serves as the standard user
 *  message shape. */
export interface LedgerPromptDef {
  name: string
  title: string
  description: string
  render: () => string
}

export function buildLedgerPrompts(): LedgerPromptDef[] {
  // The server serves the full lifetime ledger (no spawn-time scope), so the
  // briefing describes the lifetime window and the tools' optional `scope`
  // argument. This MCP server is session-independent and cannot know the
  // window currently selected in the UI.
  const briefing = buildLedgerBriefing()
  return [
    {
      name: 'coach-orient',
      title: 'Orient the coach on the current data window',
      description:
        'The MCP briefing for a coaching turn: the two scopes (coaching analysis + skill authoring), what the ledger tools are, the baked data window, and the ground-your-answer rule. The natural opening for any data-grounded coaching question.',
      render: () =>
        [
          briefing,
          '',
          'Orient with `ledger_scope` FIRST — know the window and its counts before you claim anything — then query the tools the question demands. Ground every number in the ledger and state the window your answer covers.',
        ].join('\n'),
    },
  ]
}
