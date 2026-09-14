import type { HarnessSpec } from './types.js'

/**
 * GitHub Copilot CLI — GitHub's coding agent. Speaks ACP with its own binary
 * (`copilot --acp`, the `@github/copilot` npm CLI); the same executable is
 * both the PATH probe and the spawn target. Launch command verified from the
 * official ACP registry (agent id `github-copilot-cli`). Reclassified from
 * direct-spawn (build ticket #40) to ACP by map #43 ticket #44. The probe is
 * the SPAWN TARGET only (`copilot`): a harness is only reported drivable
 * when the binary the runtime actually spawns is on PATH.
 */
const copilot: HarnessSpec = {
  kind: 'copilot',
  displayName: 'GitHub Copilot CLI',
  commands: ['copilot'],
  scrubEnv: ['GITHUB_TOKEN', 'GH_TOKEN', 'OPENAI_API_KEY'],
  preference: 9,
  adapter: {
    kind: 'acp',
    acpConfig: {
      name: 'github-copilot-cli',
      command: 'copilot',
      args: ['--acp'],
      // Copilot exposes a terminal-backed login auth method. Select it
      // explicitly so ACP does not leave the first prompt waiting while the
      // provider guesses an auth flow.
      authMethodId: 'copilot-login',
    },
  },
}

export default copilot
