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
  auth: { loginCommand: ['opencode', 'auth', 'login'] },
  preference: 3,
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
