import type { HarnessSpec } from './types.js'

/**
 * Codex CLI — driven over ACP via the `codex-acp` wrapper
 * (@agentclientprotocol/codex-acp, the ACP server for OpenAI's Codex).
 * The wrapper is BUNDLED as an app dependency (its `bin` entry resolved from
 * the app's own node_modules — no global install), because the base `codex`
 * CLI does not speak ACP. The PATH probe still wins when a global copy exists;
 * the bundled entry is the fallback detection + the runtime's spawn target.
 */
const codex: HarnessSpec = {
  kind: 'codex',
  displayName: 'Codex',
  // The ACP server binary is the SPAWN TARGET (@agentclientprotocol/codex-acp)
  // — probe IT, not the base `codex` CLI: a harness is only reported drivable
  // when the binary the runtime actually spawns is resolvable. Listing `codex`
  // as an alias would offer runs that fail at spawn. Bundled resolution (the
  // `bundled` field) supplies the entry from the app's own node_modules.
  commands: ['codex-acp'],
  bundled: {
    package: '@agentclientprotocol/codex-acp',
    bin: 'codex-acp',
  },
  scrubEnv: ['OPENAI_API_KEY'],
  preference: 2,
  // Proven live (ADR 0027 Stage 1): a real run called
  // `mcp.watchtower-ledger.ledger_scope` over the loopback-HTTP sidecar and
  // reported DB-exact counts — so the runner injects the ledger over HTTP.
  clientMcpTransport: 'http',
  adapter: {
    kind: 'acp',
    acpConfig: {
      name: 'codex',
      command: 'codex-acp',
      args: [],
    },
  },
}

export default codex
