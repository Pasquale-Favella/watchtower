# Effect as the composition model for backend workflows

Status: accepted

## Context

Watchtower has adopted Effect 4 in two separate areas: harness lifecycle
management (ADR 0030) and the ledger's SQLite client and migrations (ADR 0031).
The application still has several independent styles for managing effects:
Promise chains and callbacks for scans and network work, hand-managed timers
and cancellation in the db-worker, and imperative synchronous store methods
around the Effect SQL client. This leaves Effect's service composition,
structured concurrency, resource scopes, typed failures, and deterministic
testing available only in isolated parts of the backend.

Watchtower pins `effect` and `@effect/sql-sqlite-node` to
`4.0.0-rc.115`. The db-worker owns the SQLite connection and data plane on one
dedicated thread (ADR 0023). `node:sqlite` is synchronous, so Effect fibers do
not make an individual SQL statement non-blocking; the worker remains the
isolation boundary that keeps database work off Electron's main thread.

## Decision

Effect is the default composition and runtime model for **effectful backend
workflows** in the Electron main process, db-worker, and harness integration.
Adoption is incremental by vertical slice: when a workflow is migrated, its
orchestration and effectful dependencies use Effect end-to-end, rather than
adding thin `Effect.sync` wrappers around the old implementation. Existing
behavior and IPC contracts remain stable while slices move.

- Give each process or worker isolate one application-owned runtime, composed
  from focused `Context.Service` implementations and `Layer`s. The Electron
  main process and db-worker have separate runtimes because they have separate
  lifecycles and resource ownership. External callbacks and Promise APIs enter
  or leave Effect at these composition roots; runtime creation and `run*`
  calls do not spread through domain code.
- Model owned capabilities as services where dependency substitution,
  lifecycle, or composition is useful: the ledger repository and SQL client,
  filesystem/session-cache access, provider discovery, pricing/FX clients,
  scheduling, and harness processes. Keep pure parsing, mapping, aggregation,
  and formatting as ordinary functions. Do not create a service per helper.
- Use typed failures for expected operational outcomes, `Scope` and managed
  resources for deterministic cleanup, fibers for owned background tasks and
  cancellation, and schedules for recurring/retrying work. Use streams for
  genuinely incremental pipelines, not to disguise an in-memory collection.
  Use bounded concurrency only where operations are independent and preserve
  the existing single-writer ledger invariants.
- Run SQL as composed repository Effects. A transaction owns the complete
  read/write unit (for example, one file's port-in), and SQL failures remain in
  the Effect error channel until the db-worker protocol boundary. Because the
  Node SQLite driver is synchronous and the worker relies on per-operation
  atomicity, execute each complete SQLite repository operation synchronously
  at that boundary; do not introduce Promise yields inside a transaction. The
  SQLite driver continues to own its connection and statement cache; do not
  add a second pool or statement registry.
- Use Effect Schema as the target extraction, persistence and IPC contract
  authority under ADR 0034. Migrate one contract and its consumers together;
  each unmigrated contract continues to use its existing Zod definition until
  that slice lands. Derive TypeScript types from the authoritative schema and
  distinguish encoded rows from decoded domain values and wire payloads.
  Effect values, services and fibers never cross IPC.
- Keep React and its local state/data-fetching patterns as the renderer's UI
  runtime. The renderer consumes the Promise-based validated IPC facade and
  uses synchronous Effect Schema decoding for migrated contracts. Renderer
  validation needs no application runtime, layer, fiber or effectful decoder.
- Build service tests with test Layers and fakes; use Effect's test clock for
  time-dependent behavior and test failure, interruption, cleanup, and
  transaction rollback where relevant. Preserve integration tests against the
  real SQLite driver.

This decision supersedes the narrow adoption limit in ADR 0030 and the
"separate ADR required" limitation in ADR 0031. Those ADRs remain historical
records of the original adoption decisions; their specific implementation
constraints are replaced by this decision. Existing domain and wire contracts
remain authoritative unless separately changed.

## Migration

1. Establish the db-worker Layer/runtime composition and an Effect-native
   ledger repository. Convert the per-file port-in transaction first; retain
   the synchronous runtime edge for existing worker and store callers while
   the remaining repository surface migrates.
2. Move db-worker scan orchestration, cancellation, cadence, FX/pricing work,
   and resource cleanup to services and scoped fibers in small vertical slices.
   Keep provider parsers and transformations pure; preserve per-file commit,
   warm-cache backfill, coalescing, and clear-during-scan behavior.
3. Apply the same service/layer and lifecycle approach to main-process-owned
   asynchronous capabilities and consolidate the existing harness integration
   around its process-level runtime.
4. Replace Zod under ADR 0034 in contract dependency order, including the
   renderer tripwire adapters. Coordinate shared files with active query work;
   backend ownership improvements can advance independently of contracts that
   have no shared implementation dependency.

At every stage, keep the db-worker ownership and renderer IPC surface intact.
Remove compatibility adapters when their callers have migrated; do not make
them a permanent second API.

## Consequences

- Effect becomes a shared architectural vocabulary for effectful backend
  orchestration, dependency wiring, failure handling, resource lifetime, and
  tests, rather than a library used only by a few features.
- The main process and db-worker gain explicit composition roots and typed
  service graphs. The transition temporarily has compatibility adapters and
  mixed legacy/new slices; each adapter must have a named removal condition.
- The single-worker, single-writer data model and synchronous SQLite driver
  remain. Effect improves composition and lifecycle semantics, not SQLite's
  blocking behavior or the renderer's data contract.
- Effect is not required in pure domain code or React components; those areas
  stay simple until an actual effectful workflow benefits from the runtime.

Related: ADR 0003, ADR 0005, ADR 0023, ADR 0030, ADR 0031, ADR 0034.

## Focused session reads, 2026-10-06

`LedgerSessionReads` supplies project/session summaries, targeted session detail,
and text search. It shares `LedgerImplementation` and the worker's existing
`SqlClient` with the ingest, general query and config capabilities. A separate
read capability keeps these purpose-specific operations out of the general
snapshot port and permits focused test substitution.

Summary and search projections omit transcript inventories and unrelated
billing fields. Detail reads the requested public session ID while retaining
composite source/session identity. Each operation materializes its facts and
current config inside one synchronous transaction, then decodes after commit.
Application queries perform orchestration and wire validation; plain TypeScript
calculations receive decoded facts and explicit pricing inputs.

The four legacy project/session/detail/search builders are removed once their
callers use those queries. The remaining synchronous ledger facade and other
compatibility builders retain their existing removal conditions. This does not
add a runtime or database connection to a request. Renderer state continues to
use its existing scope key and direct refresh flow.
