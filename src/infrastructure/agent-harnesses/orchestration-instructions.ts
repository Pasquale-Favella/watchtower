import { ORCHESTRATOR_MCP_SERVER } from '@/infrastructure/agent-harnesses/orchestration.js'

/** The delegation guidance a run reads once when the orchestrator endpoint is attached. */
export const ORCHESTRATION_INSTRUCTIONS = `## Watchtower delegation

Ordinary coding tasks need no delegation tools.

- Native subagents (Claude \`Agent\`, Codex \`spawn_agent\`) are for children on your own harness and model with no settings beyond yours. Use \`delegation_start\` for another connection or model, a different effort or access mode, a separate checkout (\`isolation:"worktree"\`), a background child, or when the user asks for a delegated task.
- Call \`delegation_capabilities\` once before your first \`delegation_start\`, and again only after an error. If a connection or model is unavailable, say so; never switch unasked.
- The child sees only \`task\`: make it complete. No secrets in it.
- A running delegation's completion wakes this run. Follow its \`next\`; do not poll it with \`delegation_status\`, sleeps or watchers. Continue other work, and end your turn when none is left.
- Follow up on a delegated task or answer its question with \`delegation_send\`. A new review or re-check is a new \`delegation_start\`. Stop one you no longer need with \`delegation_cancel\`.
- As a delegated task, do the work yourself.`

/** Whether the orchestrator endpoint is among an Agent Run's attached endpoints. */
export function hasOrchestratorEndpoint(endpoints: ReadonlyArray<{ readonly name: string }> | undefined): boolean {
  return endpoints?.some(endpoint => endpoint.name === ORCHESTRATOR_MCP_SERVER) ?? false
}

/** A native slash command must stay the first thing the agent reads, so such a prompt is never wrapped. */
export function isSlashCommandPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith('/')
}

/** ACP has no system field, so the guidance rides ahead of the first prompt of a session. */
export function withAcpOrchestrationInstructions(prompt: string): string {
  return `<watchtower_instructions>\n${ORCHESTRATION_INSTRUCTIONS}\n</watchtower_instructions>\n\n<user_request>\n${prompt}\n</user_request>`
}
