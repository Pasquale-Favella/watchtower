import type { HarnessSpec } from './types.js'

/**
 * Kimi CLI — Moonshot's coding agent. Speaks ACP with its own binary
 * (`kimi acp`); the same executable is both the PATH probe and the spawn
 * target. Launch command verified from the official ACP registry (agent id
 * `kimi`). The parse-side `kimicode` provider shares this CLI.
 */
const kimi: HarnessSpec = {
  kind: 'kimi',
  displayName: 'Kimi CLI',
  commands: ['kimi'],
  scrubEnv: ['MOONSHOT_API_KEY'],
  modelListCommand: undefined,
  fallbackModels: ['kimi-k2', 'kimi-latest', 'kimi-k2-thinking'],
  preference: 8,
  adapter: {
    kind: 'acp',
    acpConfig: {
      name: 'kimi',
      command: 'kimi',
      args: ['acp'],
    },
  },
}

export default kimi
