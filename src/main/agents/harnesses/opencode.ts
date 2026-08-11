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
  modelListCommand: ['opencode', 'models'],
  fallbackModels: ['anthropic/claude-opus-4-5', 'anthropic/claude-sonnet-4-5', 'openai/gpt-5.2', 'openai/gpt-5.1-codex', 'google/gemini-3-pro-preview', 'opencode/claude-sonnet-4-5', 'opencode/gpt-5.1-codex'],
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
