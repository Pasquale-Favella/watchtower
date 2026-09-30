import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'

import { Env } from './env.js'
import { FxRates, type FxRatesRepositoryRunner } from './fx.js'
import { OperationalLog, OperationalLogLoggerLayer } from './operational-log.js'
import { HttpFetch } from './pipeline/fetch-utils.js'
import { LedgerConfig, LedgerIngest, LedgerQueries } from './store/ledger-repository.js'

/**
 * db-worker application runtime (ADR 0032): the ONE Effect runtime owned by the
 * worker isolate, composed from focused service layers — `WorkerLive`.
 *
 * Separate lifecycle from the main-process runtime by design: the two runtimes
 * never share SQLite state, because the worker owns the single writer
 * connection on its own thread (ADR 0023). The three `Ledger*` ports
 * (`LedgerIngest` / `LedgerQueries` / `LedgerConfig`, ADR 0032 §A3) ARE in this
 * graph, supplied from the store's OWN connection via `store.portsLayer` — one
 * writer, one connection, three tags. The dispatch arms still reach the ledger
 * through `LedgerStore`'s sync facade (`Effect → runSync → Effect → runSync →
 * value`); that double round-trip is what the facade-retirement slice removes,
 * and it needs the view builders on `LedgerQueries` through `R` first.
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
 * `entry.ts` and FX call sites depend on the port, never the store facade. The
 * same store instance supplies the three `Ledger*` ports, which is why the
 * root's ledger capability (`WorkerLedger`) is one interface rather than two.
 *
 * `makeWorkerRuntime`'s optional `layer` argument is the composition seam: pass
 * a graph built with the same `layerWith*` fakes the rest of the repo uses
 * (`Env.layerWithValues`, `HttpFetch.layerWithFetch`,
 * `OperationalLog.layerWithSink`, `FxRates.layerWithRates`) to prove a
 * substituted capability reaches a dispatch arm without touching the arm —
 * impossible while the layer was welded at the call site.
 */
export type WorkerServices = OperationalLog | Env | HttpFetch | FxRates | LedgerIngest | LedgerQueries | LedgerConfig

/**
 * Live `HttpFetch` for the worker, still over the bespoke `makeFetch` transport
 * and NOT the platform-client `HttpFetch.layer`.
 *
 * The bespoke transport keeps the worker's FX and pricing reads on the
 * late-bound `globalThis.fetch` resolution the per-call `liveFetchLayer()` had.
 * That property is load-bearing for exactly ONE test file:
 * `tests/db-worker.test.ts` stubs `globalThis.fetch` in its three FX-teardown
 * tests to drive the same path production does. Every other test in the repo
 * substitutes at the `HttpFetch.layerWithFetch` seam instead and would not
 * notice the difference.
 *
 * The mechanism: `layerWithFetch` stores the function reference in a closure
 * and calls it per invocation, so the thunk below re-reads `globalThis.fetch` on
 * every request. A captured `globalThis.fetch` would have frozen the first
 * stubbing test's function into the layer singleton for the rest of the
 * process. The layer value is a singleton here, so late binding - not
 * re-resolution per call - is what preserves the property.
 *
 * Against the alternative: the platform client's `Response` rebuild would drop
 * `url`/`redirected`/`type`/`statusText` and buffer the body once.
 *
 * Removal condition: compose `HttpFetch.layer` here once every
 * `globalThis.fetch`-stubbing test in the repo drives the platform client
 * instead, and the lossy `Response` rebuild is accepted for the worker's FX /
 * pricing reads. Same seam, same 8s Clock ceiling, same `{timeout|abort|network}`
 * mapping in the meantime.
 */
const liveFetchLayer: Layer.Layer<HttpFetch> = HttpFetch.layerWithFetch((input, init) => globalThis.fetch(input, init))

/**
 * What the worker root needs from the single-writer ledger: the sync repository
 * runner `FxRates.layerWithRepository` binds to, AND the three `Ledger*` ports
 * as a `Layer` (`LedgerStore.portsLayer`, which projects THIS connection rather
 * than opening a second one — ADR 0023's single-writer invariant is why the
 * ports are re-exposed instead of rebuilt).
 *
 * Kept structural, like `FxRatesRepositoryRunner`, so the composition root
 * depends on capabilities and not on the `LedgerStore` class.
 */
export interface WorkerLedger extends FxRatesRepositoryRunner {
  readonly portsLayer: Layer.Layer<LedgerIngest | LedgerQueries | LedgerConfig>
}

/** `WorkerLive` — the worker's flat live layer graph, built once per runtime. */
export const makeWorkerLive = (store: WorkerLedger): Layer.Layer<WorkerServices> =>
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
    // ADR 0032 §A3: the three ledger ports join the worker's graph, supplied
    // from the store's OWN writer connection (never a second `SqliteClient`).
    // Nothing reaches them yet — the dispatch arms still go through
    // `LedgerStore`'s sync facade. Removal condition: the arms take
    // `LedgerQueries`/`LedgerConfig` through `R`, and this entry disappears with
    // the facade in the same slice.
    store.portsLayer,
  )

/** The worker's `ManagedRuntime`: `ManagedRuntime.make(WorkerLive)`, with the
 * memoised layer build that is the whole point of this root — `Env.layer`,
 * `OperationalLog.layer`, the `FxRates` port and the three `Ledger*` ports are
 * constructed ONCE per worker lifetime instead of once per scan / FX tick /
 * dispatch arm. */
export const makeWorkerRuntime = (store: WorkerLedger, layer: Layer.Layer<WorkerServices> = makeWorkerLive(store)) =>
  ManagedRuntime.make(layer)

export type WorkerRuntime = ReturnType<typeof makeWorkerRuntime>
