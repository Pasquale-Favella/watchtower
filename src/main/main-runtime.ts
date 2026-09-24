import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'

import { HarnessProbe } from './agents/snapshot.js'
import { HttpFetch } from './pipeline/fetch-utils.js'

/**
 * Main-process application runtime (ADR 0032): the ONE Effect runtime owned
 * by the Electron main isolate, composed from focused service layers.
 *
 * Separate lifecycles/resources from the db-worker runtime by design — this
 * runtime NEVER touches the ledger connection or db-worker scopes (the
 * worker owns the ledger on its own thread behind DbWorkerClient; sharing
 * SQLite state across isolates would break the single-writer invariant).
 *
 * Flat composition via `Layer.mergeAll` — no second runtime, no `run*`
 * spreading through domain code: external callbacks and Promise APIs (IPC
 * handlers) enter Effect here. `HarnessProbe` is the minimal harness
 * capability seam (§4.3): the never-fails ACP handshake probe with
 * test-friendly fakes (`layerWithProbe`), mirroring `HttpFetch.layerWithFetch`.
 * The snapshot store itself stays Promise-bound (its `deps.detect` Promise
 * boundary + `onChange` IPC push never cross into Effect), and the run
 * seam stays injectable via `HarnessSdk` fakes — platform adoption
 * (`@effect/platform` HttpClient/FileSystem/Command) and env-only Config
 * are sequenced follow-ups, each pinned + asar-proven like ADR 0030.
 */
export const MainLive: Layer.Layer<HttpFetch | HarnessProbe> = Layer.mergeAll(HttpFetch.layer, HarnessProbe.layer)

export const mainRuntime = ManagedRuntime.make(MainLive)

export type MainRuntime = typeof mainRuntime
