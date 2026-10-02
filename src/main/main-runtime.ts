import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'

import { HarnessProbe } from './agents/snapshot.js'
import { Env } from './env.js'
import { OperationalLogLoggerLayer, OperationalLogTracerLayer } from './operational-log.js'
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
 * `Env` is the startup-immutable env-only Config seam: provided once at this
 * root via `Env.layer`, never per-call — tests substitute
 * `Env.layerWithValues` fakes with zero `process.env` mutation.
 * The snapshot store itself stays Promise-bound (its `deps.detect` Promise
 * boundary + `onChange` IPC push never cross into Effect), and the run
 * seam stays injectable via `HarnessSdk` fakes — platform adoption
 * (`@effect/platform` HttpClient/FileSystem/Command) stays a sequenced
 * follow-up, pinned + asar-proven like ADR 0030. `OperationalLogTracerLayer`
 * and `OperationalLogLoggerLayer` are References, not `Context.Service`s, so
 * they add nothing to `R` and the declared service set is unchanged.
 */
export const MainLive: Layer.Layer<HttpFetch | HarnessProbe | Env> = Layer.mergeAll(
  HttpFetch.layer,
  HarnessProbe.layer,
  Env.layer,
  // A12: the Logger half, and the reason the operational records in this
  // isolate reach the file at all. `Effect.log*` is the one logging path, so a
  // converted site only files when the `Logger` reference is installed here —
  // exactly as the worker root has installed it since A7. It also REPLACES
  // Effect's default console loggers, so main's logs land in the Operational
  // file and nowhere else (no console duplication).
  OperationalLogLoggerLayer,
  // A7: the main isolate gets the tracer too. Worker-only would leave every
  // `Effect.fn('…')` span built here dangling — the problem relocated, not
  // solved. Unlike the worker's copy, these records DO reach the file: main owns
  // the Operational-log writer (ADR 0029).
  OperationalLogTracerLayer('main'),
)

export const mainRuntime = ManagedRuntime.make(MainLive)

export type MainRuntime = typeof mainRuntime
