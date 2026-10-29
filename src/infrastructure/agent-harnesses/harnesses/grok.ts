import type { HarnessSpec } from './types.js'

/**
 * Grok Build — driven over ACP with its own binary (`grok agent stdio`);
 * the same executable is both the PATH probe and the spawn target.
 */
const grok: HarnessSpec = {
  kind: 'grok',
  displayName: 'Grok Build',
  commands: ['grok'],
  scrubEnv: ['XAI_API_KEY'],
  preference: 4,
  adapter: {
    kind: 'acp',
    acpConfig: {
      name: 'grok-build',
      command: 'grok',
      args: ['agent', 'stdio'],
    },
  },
}

export default grok
