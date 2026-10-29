import type { HarnessSpec } from './types.js'

/**
 * Goose — Block's coding agent. Speaks ACP with its own binary
 * (`goose acp`); the same executable is both the PATH probe and the spawn
 * target. Launch command verified from the official ACP registry (agent id
 * `goose`).
 */
const goose: HarnessSpec = {
  kind: 'goose',
  displayName: 'Goose',
  commands: ['goose'],
  scrubEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'],
  auth: { loginCommand: ['goose', 'configure'] },
  preference: 6,
  adapter: {
    kind: 'acp',
    acpConfig: {
      name: 'goose',
      command: 'goose',
      args: ['acp'],
    },
  },
}

export default goose
