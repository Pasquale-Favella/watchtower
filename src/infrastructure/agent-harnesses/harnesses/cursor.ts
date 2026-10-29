import type { HarnessSpec } from './types.js'

/**
 * Cursor Agent — the standalone agent CLI from Cursor (the IDE itself is an
 * ACP *client* and out of scope on the run side, but `cursor-agent` is a
 * drivable agent). Speaks ACP with its own binary (`cursor-agent acp`);
 * launch command verified from the official ACP registry (agent id
 * `cursor`). Reclassified from parse-only by map #43 ticket #44.
 */
const cursor: HarnessSpec = {
  kind: 'cursor',
  displayName: 'Cursor Agent',
  commands: ['cursor-agent'],
  scrubEnv: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
  auth: { loginCommand: ['cursor-agent', 'login'] },
  preference: 12,
  adapter: {
    kind: 'acp',
    acpConfig: {
      name: 'cursor',
      command: 'cursor-agent',
      args: ['acp'],
    },
  },
}

export default cursor
