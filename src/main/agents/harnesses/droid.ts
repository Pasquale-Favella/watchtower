import type { HarnessSpec } from './types.js'

/**
 * Droid — Factory's coding agent. Speaks ACP as a daemon
 * (`droid exec --output-format acp-daemon`); the same executable is both the
 * PATH probe and the spawn target. Launch command verified from the official
 * ACP registry (agent id `factory-droid`). Reclassified from
 * listed-but-not-drivable by map #43 ticket #44.
 */
const droid: HarnessSpec = {
  kind: 'droid',
  displayName: 'Droid',
  commands: ['droid'],
  scrubEnv: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
  modelListCommand: undefined,
  fallbackModels: ['gpt-5.2', 'gpt-5.1'],
  preference: 13,
  adapter: {
    kind: 'acp',
    acpConfig: {
      name: 'factory-droid',
      command: 'droid',
      args: ['exec', '--output-format', 'acp-daemon'],
    },
  },
}

export default droid
