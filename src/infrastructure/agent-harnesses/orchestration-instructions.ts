import { ORCHESTRATOR_MCP_SERVER } from '@/infrastructure/agent-harnesses/orchestration.js'

const TOOLS = ['capabilities', 'start', 'status', 'read', 'send', 'cancel'] as const

/**
 * How each harness reaches the tools. Claude and Codex defer MCP tools out of the list the model reads, so the
 * guidance names the callable form, and for Claude how to load it.
 */
const ACCESS = {
  claude: `Delegation tools are \`mcp__${ORCHESTRATOR_MCP_SERVER}__delegation_*\`. If they are not loaded, load them first with ToolSearch \`select:${TOOLS.map(tool => `mcp__${ORCHESTRATOR_MCP_SERVER}__delegation_${tool}`).join(',')}\`.`,
  codex:
    'Delegation tools are `mcp__watchtower_orchestrator__delegation_*`, inside `exec` as `tools.mcp__watchtower_orchestrator__delegation_*`. They can be missing from the tools listed to you and are still callable.',
  acp: `Delegation tools are \`delegation_*\` on the \`${ORCHESTRATOR_MCP_SERVER}\` MCP server; your harness may prefix them with that server name. If they are not in your tool list, search your tools for "delegation" before you say they are missing.`,
} as const

export type OrchestrationHarness = keyof typeof ACCESS

/** The delegation guidance a run reads once when the orchestrator endpoint is attached. */
export function orchestrationInstructions(harness: OrchestrationHarness): string {
  return `## Watchtower delegation

Watchtower runs delegated tasks on the user's connected harnesses and models. ${ACCESS[harness]}

- When the user asks to delegate, hand off, or run work with another harness, connection or model (for example "an opencode delegate using <model>" or "have claude review this"), call \`delegation_capabilities\`, match their words to a connection and model, and call \`delegation_start\`, not config files, scripts or native subagents.
- Native subagents (Claude \`Agent\`, Codex \`spawn_agent\`) are only for children on your own harness and model with no settings beyond yours. Use \`delegation_start\` for another connection or model, a different effort or access mode, a separate checkout (\`isolation:"worktree"\`), or a background child. Ordinary coding tasks need neither.
- Model lists are short: if the named model is missing, call \`delegation_capabilities\` with \`search\` set to the user's words (such as "flint free") before calling it unavailable. Start one task per requested delegate. Each starts in its own conversation. Never switch models unasked.
- The child sees only \`task\`: make it complete. No secrets in it.
- Completion wakes this run: follow \`next\`, never poll with \`delegation_status\`, sleeps or watchers, and end your turn when no other work is left.
- Follow up on a delegated task or answer its question with \`delegation_send\`. A new review or re-check is a new \`delegation_start\`. Stop one you no longer need with \`delegation_cancel\`.
- As a delegated task, do the work yourself.`
}

/** Whether the orchestrator endpoint is among an Agent Run's attached endpoints. */
export function hasOrchestratorEndpoint(endpoints: ReadonlyArray<{ readonly name: string }> | undefined): boolean {
  return endpoints?.some(endpoint => endpoint.name === ORCHESTRATOR_MCP_SERVER) ?? false
}

/** A native slash command must stay the first thing the agent reads, so such a prompt is never wrapped. */
export function isSlashCommandPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith('/')
}

/** Claude and Codex wrapped as ACP agents still defer MCP tools their own way, so they read their own variant. */
export function acpOrchestrationHarness(name: string | null | undefined, title?: string | null): OrchestrationHarness {
  const identity = `${name ?? ''} ${title ?? ''}`.toLowerCase()
  if (identity.includes('claude')) return 'claude'
  if (identity.includes('codex')) return 'codex'
  return 'acp'
}

/** ACP has no system field, so the guidance rides ahead of the first prompt of a session. */
export function withAcpOrchestrationInstructions(prompt: string, harness: OrchestrationHarness = 'acp'): string {
  return `<watchtower_instructions>\n${orchestrationInstructions(harness)}\n</watchtower_instructions>\n\n<user_request>\n${prompt}\n</user_request>`
}
