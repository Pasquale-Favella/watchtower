import type { HarnessSpec } from './types.js'

/**
 * Claude Code — driven over ACP via the `claude-agent-acp` wrapper
 * (@agentclientprotocol/claude-agent-acp, the ACP server for Anthropic's
 * Claude, running on the Claude Agent SDK). The wrapper is BUNDLED as an app
 * dependency (resolved from the app's own node_modules — no global install),
 * because the base `claude` CLI does not speak ACP natively (no --acp flag);
 * the wrapper reads the CLI's stored login. The PATH probe still wins when a
 * global copy exists; the bundled entry is the fallback detection + the
 * runtime's spawn target.
 */
const claude: HarnessSpec = {
  kind: 'claude',
  displayName: 'Claude Code',
  // The ACP server binary is the SPAWN TARGET (@agentclientprotocol/
  // claude-agent-acp) — probe IT, not the base `claude` CLI: a harness is
  // only reported drivable when the binary the runtime actually spawns is
  // resolvable. Listing `claude` as an alias would offer runs that fail at
  // spawn. Bundled resolution (the `bundled` field) supplies the entry from
  // the app's own node_modules.
  commands: ['claude-agent-acp'],
  bundled: {
    package: '@agentclientprotocol/claude-agent-acp',
    bin: 'claude-agent-acp',
  },
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
