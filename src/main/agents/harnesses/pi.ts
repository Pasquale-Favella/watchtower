import type { HarnessSpec } from './types.js'

/**
 * Pi — Inflection's coding agent. Exposed as an ACP server via the
 * `pi-acp` adapter package (registry agent `pi-acp`); the spawn target is
 * `pi-acp`, so that is the PATH probe — a harness is only reported drivable
 * when the binary the runtime actually spawns is on PATH.
 */
const pi: HarnessSpec = {
  kind: 'pi',
  displayName: 'Pi',
  commands: ['pi-acp'],
  scrubEnv: ['PI_API_KEY'],
  preference: 14,
  adapter: {
    kind: 'acp',
    acpConfig: {
      name: 'pi-acp',
      command: 'pi-acp',
      args: [],
    },
  },
}

export default pi
