import type { HarnessSpec } from './types.js'

/**
 * Codex CLI — driven over ACP via the `codex-acp` wrapper
 * (@agentclientprotocol/codex-acp, the ACP server for OpenAI's Codex).
 * The base `codex` CLI is the PATH probe; the ACP server binary is the
 * spawn target (installed together by the wrapper package).
 */
const codex: HarnessSpec = {
  kind: 'codex',
  displayName: 'Codex',
  // The ACP server binary is the SPAWN TARGET (@agentclientprotocol/codex-acp)
  // — probe IT, not the base `codex` CLI: a harness is only reported drivable
  // when the binary the runtime actually spawns is on PATH. Listing `codex` as
  // an alias would offer runs that fail at spawn.
  commands: ['codex-acp'],
  scrubEnv: ['OPENAI_API_KEY'],
  preference: 2,
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
