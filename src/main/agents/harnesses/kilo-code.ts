import type { HarnessSpec } from './types.js'

/**
 * Kilo Code — the open-source agent with a standalone CLI. Speaks ACP with
 * its own binary (`@kilocode/cli acp`, installed as `kilocode`/`kilo`); the
 * same executable is both the PATH probe and the spawn target. Launch
 * command verified from the official ACP registry (agent id `kilo`).
 */
const kiloCode: HarnessSpec = {
  kind: 'kilo-code',
  displayName: 'Kilo Code',
  // The `@kilocode/cli` package installs the `kilocode` binary; probe the
  // SPAWN TARGET only — a harness is only reported drivable when the binary
  // the runtime actually spawns is on PATH.
  commands: ['kilocode'],
  scrubEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'],
  modelListCommand: undefined,
  fallbackModels: ['claude-sonnet-4-5', 'gpt-5.2', 'gemini-3-pro-preview'],
  preference: 11,
  adapter: {
    kind: 'acp',
    acpConfig: {
      name: 'kilo',
      command: 'kilocode',
      args: ['acp'],
    },
  },
}

export default kiloCode
