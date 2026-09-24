import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'

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
 * Starts with what the updates wiring needs (`HttpFetch` live). Harness
 * capabilities join later by merging their layers into `MainLive` (e.g.
 * `Layer.mergeAll(HttpFetch.layer, NextCapability.layer)`) — no second
 * runtime, and no `run*` calls spreading through domain code: external
 * callbacks and Promise APIs (IPC handlers) enter Effect here.
 */
export const MainLive: Layer.Layer<HttpFetch> = HttpFetch.layer

export const mainRuntime = ManagedRuntime.make(MainLive)

export type MainRuntime = typeof mainRuntime
