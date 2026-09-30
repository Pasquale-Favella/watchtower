import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'

import { Env } from './env.js'
import { FxRates, type FxRatesRepositoryRunner } from './fx.js'
import { OperationalLog, OperationalLogLoggerLayer } from './operational-log.js'
import { HttpFetch } from './pipeline/fetch-utils.js'

/**
 * db-worker application runtime (ADR 0032): the ONE Effect runtime owned by the
 * worker isolate, composed from focused service layers — `WorkerLive`.
 *
 * Separate lifecycle from the main-process runtime by design: the two runtimes
 * never share SQLite state, because the worker owns the single writer
 * connection on its own thread (ADR 0023). The ledger repository itself stays
 * reached through `LedgerStore`'s own `ManagedRuntime`
 * (`store/node-sqlite-client.ts`) until the repository-split slice moves it
 * behind this graph.
 *
 * Flat composition via `Layer.mergeAll` — no second runtime and no `run*`
 * spreading through domain code: the `worker_threads` message handler
 * (`db-worker/entry.ts`) is itself a legitimate composition root, so Effect
 * programs enter and leave here and nowhere else. `Env` is the
 * startup-immutable env-only Config seam: provided ONCE at this root via
 * `Env.layer`, never per-call (it used to be rebuilt on every scan), and tests
 * substitute `Env.layerWithValues` fakes with zero `process.env` mutation.
 *
 * `FxRates` is built from the repository runner the caller owns
 * (`FxRatesRepositoryRunner` — a worker-owned `LedgerStore` satisfies it), so
 * the composition root and the single writer are created together in
 * `entry.ts` and FX call sites depend on the port, never the store facade.
 *
 * `makeWorkerRuntime`'s optional `layer` argument is the composition seam: pass
 * a graph built with the same `layerWith*` fakes the rest of the repo uses
 * (`Env.layerWithValues`, `HttpFetch.layerWithFetch`,
 * `OperationalLog.layerWithSink`, `FxRates.layerWithRates`) to prove a
 * substituted capability reaches a dispatch arm without touching the arm —
 * impossible while the layer was welded at the call site.
 */
export type WorkerServices = OperationalLog | Env | HttpFetch | FxRates

/**
 * Live `HttpFetch` for the worker, still over the bespoke `makeFetch` transport
 * and NOT the platform-client `HttpFetch.layer`: the worker's FX and pricing
 * reads keep the late-bound `globalThis.fetch` resolution that the per-call
 * `liveFetchLayer()` had (the test suite stubs `globalThis.fetch` to drive the
 * same path production does), and the platform client's `Response` rebuild
 * would drop `url`/`redirected`/`type`/`statusText` and buffer the body once.
 * The layer value is a singleton here, so late binding is what preserves the
 * "tests stub global fetch" property, not re-resolution per call.
 *
 * Removal condition: compose `HttpFetch.layer` here once every
 * `globalThis.fetch`-stubbing test in the repo drives the platform client
 * instead, and the lossy `Response` rebuild is accepted for the worker's FX /
 * pricing reads. Same seam, same 8s Clock ceiling, same `{timeout|abort|network}`
 * mapping in the meantime.
 */
const liveFetchLayer: Layer.Layer<HttpFetch> = HttpFetch.layerWithFetch((input, init) => globalThis.fetch(input, init))

/** `WorkerLive` — the worker's flat live layer graph, built once per runtime. */
export const makeWorkerLive = (store: FxRatesRepositoryRunner): Layer.Layer<WorkerServices> =>
  Layer.mergeAll(
    // F14's dead bridge, installed at a root: `Effect.log` records now reach
    // the main-owned pino sink through `OperationalLogLogger` instead of being
    // dropped, and the default console loggers no longer duplicate them on the
    // worker's stdout. In the worker thread `active` is null (main owns the
    // file, ADR 0029), so the logger is a never-throwing no-op here — the point
    // is that the bridge is CONNECTED, not that this thread writes the file.
    OperationalLogLoggerLayer,
    Env.layer,
    OperationalLog.layer,
    liveFetchLayer,
    FxRates.layerWithRepository(store),
  )

/** The worker's `ManagedRuntime`: `ManagedRuntime.make(WorkerLive)`, with the
 * memoised layer build that is the whole point of this root — `Env.layer`,
 * `OperationalLog.layer` and the `FxRates` port are constructed ONCE per
 * worker lifetime instead of once per scan / FX tick / dispatch arm. */
export const makeWorkerRuntime = (
  store: FxRatesRepositoryRunner,
  layer: Layer.Layer<WorkerServices> = makeWorkerLive(store),
) => ManagedRuntime.make(layer)

export type WorkerRuntime = ReturnType<typeof makeWorkerRuntime>
