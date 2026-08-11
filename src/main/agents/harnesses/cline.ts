import type { HarnessSpec } from './types.js'

/**
 * Cline — the open-source VS Code agent with a standalone CLI. Speaks ACP
 * with its own binary (`cline --acp`); the same executable is both the PATH
 * probe and the spawn target. Launch command verified from the official ACP
 * registry (agent id `cline`).
 */
const cline: HarnessSpec = {
  kind: 'cline',
  displayName: 'Cline',
  commands: ['cline'],
  scrubEnv: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY'],
  modelListCommand: undefined,
  fallbackModels: ['claude-sonnet-4-5', 'gpt-5.2', 'gemini-3-pro-preview'],
  preference: 10,
  adapter: {
    kind: 'acp',
    acpConfig: {
      name: 'cline',
      command: 'cline',
      args: ['--acp'],
    },
  },
}

export default cline
