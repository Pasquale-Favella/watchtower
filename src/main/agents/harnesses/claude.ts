import type { HarnessSpec } from './types.js'

/**
 * Claude Code — driven over ACP via the `claude-agent-acp` wrapper
 * (@agentclientprotocol/claude-agent-acp, the ACP server for Anthropic's
 * Claude). The base `claude` CLI is the PATH probe; the ACP server binary is
 * the spawn target (they are installed together by the wrapper package).
 */
const claude: HarnessSpec = {
  kind: 'claude',
  displayName: 'Claude Code',
  // The ACP server binary is the SPAWN TARGET (@agentclientprotocol/
  // claude-agent-acp) — probe IT, not the base `claude` CLI: a harness is
  // only reported drivable when the binary the runtime actually spawns is on
  // PATH. Listing `claude` as an alias would offer runs that fail at spawn.
  commands: ['claude-agent-acp'],
  scrubEnv: ['ANTHROPIC_API_KEY'],
  preference: 1,
  adapter: {
    kind: 'acp',
    acpConfig: {
      name: 'claude-code',
      command: 'claude-agent-acp',
      args: [],
    },
  },
}

export default claude
