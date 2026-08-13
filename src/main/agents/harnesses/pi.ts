import type { HarnessSpec } from './types.js'

/**
 * Pi — Inflection's coding agent. Exposed as an ACP server via the `pi-acp`
 * adapter package (registry agent `pi-acp`); the spawn target is `pi-acp`.
 * The adapter is BUNDLED as an app dependency (resolved from the app's own
 * node_modules — no global install), because the base `pi` CLI does not
 * speak ACP natively (its `--mode rpc` is a proprietary dialect) — `pi-acp`
 * translates ACP to that RPC. The PATH probe still wins when a global copy
 * exists; the bundled entry is the fallback detection + the runtime's spawn
 * target. Because `pi-acp` shells out to the base `pi` binary (`pi --mode
 * rpc`), the spec REQUIRES `pi` on PATH — a bundled adapter without the
 * agent CLI would offer runs that fail at spawn.
 */
const pi: HarnessSpec = {
  kind: 'pi',
  displayName: 'Pi',
  commands: ['pi-acp'],
  bundled: {
    package: 'pi-acp',
    bin: 'pi-acp',
  },
  requires: ['pi'],
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
