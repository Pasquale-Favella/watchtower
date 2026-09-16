import type { HarnessSpec } from './types.js'

/**
 * OpenCode — driven over ACP with its own binary (`opencode acp`); the same
 * executable is both the PATH probe and the spawn target. Model discovery
 * stays native (`opencode models`).
 */
const opencode: HarnessSpec = {
  kind: 'opencode',
  displayName: 'OpenCode',
  commands: ['opencode', 'opencode-ai'],
  scrubEnv: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
  preference: 3,
  // Proven live (ADR 0027 Stage 1): a real run called
  // `watchtower-ledger_ledger_scope` over the loopback-HTTP sidecar and
  // reported DB-exact counts — so the runner injects the ledger over HTTP.
  clientMcpTransport: 'http',
  adapter: {
    kind: 'acp',
    acpConfig: {
      name: 'opencode',
      command: 'opencode',
      args: ['acp'],
    },
  },
}

export default opencode
