import type { HarnessSpec } from './types.js'

/**
 * Qwen Code — Alibaba's coding agent. Speaks ACP with its own binary
 * (`qwen-code --acp --experimental-skills`); the same executable is both the
 * PATH probe and the spawn target. Launch command verified from the official
 * ACP registry (agent id `qwen-code`).
 */
const qwen: HarnessSpec = {
  kind: 'qwen',
  displayName: 'Qwen Code',
  // Probe the SPAWN TARGET only (`qwen-code`): a harness is only reported
  // drivable when the binary the runtime actually spawns is on PATH.
  commands: ['qwen-code'],
  scrubEnv: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
  preference: 7,
  adapter: {
    kind: 'acp',
    acpConfig: {
      name: 'qwen-code',
      command: 'qwen-code',
      args: ['--acp', '--experimental-skills'],
    },
  },
}

export default qwen
