import type { HarnessSpec } from './types.js'

/**
 * Gemini CLI — Google's coding agent. Speaks ACP with its own binary
 * (`gemini --acp`); the same executable is both the PATH probe and the
 * spawn target. Launch command verified from the official ACP registry
 * (agent id `gemini`).
 */
const gemini: HarnessSpec = {
  kind: 'gemini',
  displayName: 'Gemini CLI',
  commands: ['gemini'],
  scrubEnv: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
  modelListCommand: undefined,
  fallbackModels: ['gemini-3-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  preference: 5,
  adapter: {
    kind: 'acp',
    acpConfig: {
      name: 'gemini',
      command: 'gemini',
      args: ['--acp'],
    },
  },
}

export default gemini
