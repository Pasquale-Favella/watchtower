# Effect adoption assessment, 2026-09-30

The baseline is the [penultimate comment on #148](https://github.com/Pasquale-Favella/watchtower/issues/148#issuecomment-5889976240), including its Wave 1 corrections. The [latest comment](https://github.com/Pasquale-Favella/watchtower/issues/148#issuecomment-5892340733) and subsequent commits update its status. The execution order is integrated into [the adoption plan, section 6](../plans/effect-adoption.md#6-current-execution-order).

The assessment began at `a917305`. Local commit `ce81593` subsequently landed the ledger row Schema conversion and typed repository decode failures. PR #147 still pointed to `a917305` when the assessment was published. This is a source and architecture assessment; its census and conclusions were [published on issue #148](https://github.com/Pasquale-Favella/watchtower/issues/148#issuecomment-5913654224). No tests, build or benchmarks were run for the assessment. Implementation and its verification are recorded separately in the target architecture's execution record.

## Scope and completion criteria

Full adoption means Effect composes the backend's owned IO, dependencies, failures, and lifetimes. Each long-lived isolate owns its runtime and resources. Framework callbacks enter that runtime at explicit boundaries.

Pure parsing, calculation, formatting, and React state need no Effect runtime. The owner's later decision permits synchronous `effect/Schema` validation in the renderer to replace Zod. Effect values, fibers, and services stay inside their isolate. SQLite remains synchronous and the worker remains its single writer.

Completion requires observable properties:

- Each runtime owns its layer graph, child scopes, and shutdown. The worker has one writable connection; the MCP isolate owns its own read-only connection.
- Migrated workflows compose service Effects without calling a second runtime to obtain values. Remaining Promise adapters have owners, cancellation contracts, and removal conditions.
- Expected SQL, decode, fetch, and process failures stay typed until the protocol boundary maps them to existing responses.
- Cancellation stops underlying work and releases resources under a bounded drain policy, including when an iterator or Promise never settles.
- Records from each emitting isolate reach the main-owned operational log through the validated forwarding path.
- Schema changes preserve accepted inputs and decoded outputs. Deliberate behavior changes are documented. Each contract has one authoritative schema.

Import counts and Effect LOC share do not establish these properties.

## Status against the baseline

| Baseline item                                | Current disposition                                                 | Evidence                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Slice 0, query measurement                   | Complete as historical evidence; no new timing claim                | `d4d90a2`, [measurement](./query-path-measurement.md)                     |
| Slice 1, worker root                         | Implemented; connection ownership and observation incomplete        | `7402e72`, `makeWorkerLive`, F27/F28 below                                |
| Slice 2, fetch retry                         | Implemented                                                         | `43b5fe2`, `retryTransientFetch` and four callers                         |
| Slice 3, repository split                    | Implemented; facade and nested runtime remain                       | `77cac17`, three ledger ports, `NodeSqliteDatabase.runSync`               |
| Slice 4, lint rules                          | Implemented as warnings                                             | `03255fe`, `eslint.config.mjs`                                            |
| Slice 5a, narrower reads                     | Call projection committed; further reduction and measurement remain | `b7f47e7` adds the 29-column call projection; `ce81593` converts decoding |
| SqlModel                                     | Declined                                                            | `e7f7efd`; generated single-table CRUD does not fit existing ingest       |
| RPC rewrite                                  | Declined                                                            | `27fc60e`, [spike](./effect-unstable-rpc-spike.md)                        |
| FileSystem for sync discovery                | Closed with a Node exception                                        | `d45c21d` and recorded discovery decision                                 |
| RcMap/Pool for app-scoped sidecar            | Declined; attachment hardening complete                             | `67c1e79`, ADR 0027                                                       |
| A7 tracing; A10 logging                      | Implemented locally; worker forwarding incomplete                   | `d4214f1`, `476626e`, `42ce59c`; pino removed from dependencies           |
| Schema Wave B                                | Authorized by later owner decision; pending                         | `7fff64a`, A11. Earlier decline recommendation superseded                 |
| F23 Windows runner                           | Recorded, intentionally unscheduled                                 | Owner decision in latest issue comment                                    |
| F25 Coach retention; F26 virtual-time stalls | Open                                                                | Registry code and mitigation notes at `a917305`                           |

[PR #147](https://github.com/Pasquale-Favella/watchtower/pull/147) still describes a narrow migration foundation and contains `Closes #148`. Its September 24 rollout comment also says work is complete. Both are stale relative to this programme. Tracker maintenance should refresh the scope and remove automatic closure while work remains.

## Architectural findings and corrections

### F27. The worker borrows services from a separate runtime

`NodeSqliteDatabase` constructs a `ManagedRuntime` at `src/main/store/node-sqlite-client.ts:34`. Its `portsLayer` obtains that runtime's context and re-exposes it with `Layer.succeedContext`. `makeWorkerLive` merges it into another runtime. The connection belongs to the database runtime's scope, rather than the worker runtime advertising its ports.

Production therefore constructs a main runtime, a worker orchestration runtime, a worker database runtime, and a database runtime in the MCP process. The MCP runtime belongs to a separate isolate. The two worker runtimes are the remaining consolidation work. Ad hoc `Effect.run*` calls are execution boundaries, rather than additional `ManagedRuntime` instances.

The borrowed context preserves one connection today but needs manual disposal ordering. Repository services also originate in the database construction context, and facade calls execute in that runtime. A tracer installed only in `WorkerLive` does not establish that repository operations use it.

Make the SQLite client, migration initialization, and ledger ports layers owned by the worker root. Migrations finish before `ready`. A temporary synchronous facade may run through that same runtime at an external boundary. Complete transactions stay synchronous, without Promise waits or scheduler yields. The MCP root owns a separate read-only client and closes it with the SDK/server lifecycle.

Acceptance should count connection acquisition and disposal, substitute query/config ports through the root, preserve rollback and boot rejection, and show that the worker has no nested database runtime. Splitting repository tags alone does not satisfy this.

### F28. Worker Effect logs and spans need a forwarding sink

`src/main/operational-log.ts` holds `active` as isolate-local module state. Main initializes the writer. The worker's logger, service, and tracer delegate to their module's local writer seam, which has no active writer there.

The existing `oplog` event works. `DbWorkerContext.emitScanStart`, `emitScanFinish`, and `emitScanFailure` send records; `relayWorkerEvents` in `src/main/index.ts` files them as `worker`. The Logger and Tracer do not use that event. Layer installation proves configuration, rather than delivery. The snapshot's standalone `runFork` installs a logger but no tracer; other independent execution boundaries also need an explicit observation context.

Construct Logger, Tracer, and the service from one sink parameter. Main supplies the local writer; the worker supplies an emitter over the existing `oplog` event. Sanitize before forwarding and at the writer, preserve `worker` context, and serialize no arbitrary Cause, span attributes, messages, or ledger facts. Retain one file and the packaged debug filter. Measure volume before adding per-row spans.

Acceptance is an actual worker-produced Effect log, counter, and completed repository span received once by a fake main sink, plus a worker integration check. Layer-presence assertions cannot close F14. No exporter or new privacy decision is needed.

### F29. Load query data with Effect; calculate views from explicit data

The old end-state plan calls view builders pure, yet `queryScope` takes `LedgerStore` and reads the database. `src/main/store/aggregate.ts:74` holds mutable module-level `pricingConfig`, replaced by `loadConfig` per query. These are workflows with hidden dependencies.

Separate an Effect loader from plain calculations. The loader obtains rows, aliases, overrides, and the pricing data required for a request. Calculations receive that request snapshot explicitly. This removes store access and mutable pricing lookup state from calculation while preserving typed query failures.

Start by sharing data within one request. `store:analytics` and `overview:query` repeat aggregation today. Avoiding those duplicate reads needs no cross-request cache. Any later cache needs a memory bound and revisions covering relevant committed ingest, clear/delete, aliases, overrides, and pricing refresh. Currency conversion belongs in the key or after cached USD results. An MCP process cannot observe a worker-local revision; use a database-visible revision or keep its cache request-local.

Preserve scope semantics. `assembleSession` filters complete turns by the first assistant call's timestamp at `aggregate.ts:270`. A timestamp predicate applied independently to every call can split turns and change costs. Separate summary, detail, and search reads before omitting prompt text or adding SQL predicates and pagination.

**Correction to slice 5:** the measured calculation share below 6% bounds replacing JS calculation while keeping the same input rows. It does not bound a SQL aggregate that avoids materializing and decoding most rows. SQL grouping remains a candidate after parity and before/after measurement. No speedup is claimed for the current worktree or for changing schema libraries.

### F30. F25 needs cancellation that can run while event pulling is stuck

`activeRuns` strongly retains each generator. `cancelledRuns` and `cancelPromises` also depend on settlement for cleanup. `cancel()` calls the outer generator's `return()`. In `runtime.run`, that generator can be awaiting the SDK iterator's `next()`. Its AbortController and provider teardown become reachable when `finally` executes. A pending generator operation can prevent cancellation from reaching those finalizers. The reset timeout bounds the caller's wait, rather than the generator or child lifetime.

**Correction to F25:** `FinalizationRegistry` cannot reclaim a generator strongly reachable from `activeRuns`. Garbage collection provides no timely process cleanup. A timeout on `return()` alone also leaves work running.

Give the run owner a handle containing events and an idempotent stop operation. Stop signals the SDK operation or process independently of a pending pull. Track the pump/fiber as owned work. Cancel/reset/dispose suppress late events, stop the run, perform bounded drain, and release registry entries and attachments exactly once. A failed graceful stop needs an explicit forced process teardown policy. Avoid a blanket duration timeout that cuts off valid long conversations.

A raw `Stream.fromAsyncIterable` replacement is insufficient. In rc.115, `Channel.fromAsyncIterable` at `node_modules/effect/src/Channel.ts:1930` registers an `Effect.promise(() => iter.return!())` finalizer without a deadline. Interrupting a pull does not bound that finalizer. Use the independent stop handle and bounded cleanup with either adapter.

Future checks need a `next()` that never resolves, a hanging `return()`, cancel racing reset, and a new run starting during reset. Assert child teardown, bounded registries, no late events, and workspace ownership. This correctness work can precede A6 and proceed independently of ledger changes.

### F31. Scan cancellation needs the parser's completion barrier

`runScan` calls `parseAllSessions` through `Effect.tryPromise` without using its cancellation signal. Its delta callback checks `scanAbortFlag` before forwarding. The callback in `DbWorkerContext.performScan` can then await `getRepoUrl` before writing. Fiber interruption alone does not prove this underlying Promise has settled or cannot write later.

This is a source-level risk, rather than a reproduced post-shutdown write. The existing flag and graceful close provide protection but do not express Promise ownership or a second guard after the async lookup. A later scan can also reset a shared flag while old Promise work is settling.

Keep pure parsers plain. Give each scan its own token/generation and an underlying completion barrier. Guard port-in after asynchronous lookups. Do not publish idle, permit a replacement scan, or release SQLite until old work drains under the shutdown policy. Keeping the Promise adapter requires this contract regardless of broader parser migration.

Verify delayed URL lookup, abort followed by a new scan, and worker close during parsing. Old generations must make no late writes or progress, and shutdown must not release SQLite under surviving parser work.

### F32. Typed decoding must reach the protocol boundary

Commit `ce81593` uses `Schema.decodeUnknownEffect` and widens reads to `SqlError | SchemaError`. The facade still executes repository Effects with `runSync` and returns values to dispatch/export callers. A typed repository signature alone cannot provide Section fallback or an operational failure code.

Carry errors through the loader and dispatch Effect, then map them once to existing responses and bounded operational codes. Preserve defects separately. Do not represent corrupt facts as a successful empty ledger. Define fallback per operation; an FX cache error and a ledger facts error need different policies. Any retained synchronous boundary should inspect Exit before serializing failure, rather than depend on an opaque thrown wrapper.

Migrate schema consumers atomically per contract. Repeated codecs in `read-projections.ts` and `shared/schemas/ledger.ts` should derive from common field codecs where practical, while keeping projection and wire shapes separate. Preserve finite checks, coercion, optional/null behavior, mutable arrays, JSON decoding, and key transforms. The recorded parity rules guide implementation; they do not prove every candidate has passed.

## Constraints on the remaining work

- Mitigate F26 before relying on more full-suite gates. `it.effect` is useful, but adopting it alone does not prove the hang is fixed. Check scheduler registration, retry windows, interruption, and a real-time ceiling outside virtual time. Confirm rc.115 compatibility before adding `@effect/vitest`.
- F22 should use a dedicated test tsconfig with aliases and DOM types required by tests importing renderer modules. Keep production Node and web compilation separate; add an explicit test typecheck command for CI.
- Make the main snapshot a scoped service with its actual `clientVersion` dependency. Consume `HarnessProbe` through that graph or remove the unused tag. A row map alone does not justify LayerMap. Preserve probe coalescing, newest-request selection, and superseded responses.
- Keep lint warn-only under the repository policy. Migrated workflows need no newly unexplained violations and named boundary exceptions. A ThrowStatement rule cannot detect a validator's internal throw.
- Amend ADRs 0003, 0005, and 0032 before shared schema replacement changes their contract-source statements. ADR 0029 already records the local writer with no logging dependency; preserve its ownership and privacy requirements. These updates document the existing decisions.

## Recommended order

F25 and F26 can proceed independently of ledger files. Complete and measure 5a under its current owner. Add the worker observation sink, preserve typed failures through callers, and consolidate SQLite into the worker root. Separate loading from calculation, reuse request data, and retire the facade across worker and MCP consumers.

Further projections, SQL reduction, and bounded caches follow from that model and measurements. Main snapshot consolidation and a controlled Coach run follow their own dependency chain. Schema Waves A and B follow contract dependencies and ADR updates. RPC, generated SqlModel repositories, app-scoped RcMap, and a Windows runner remain outside scheduled work under the recorded decisions.

## Further findings from the product and schema paths

The follow-up scope explicitly includes complete Zod replacement, code structure, fewer round trips and product correctness. [The target architecture](../plans/effect-target-architecture.md) defines the dependency boundaries, schema ownership and implementation gates. ADR 0034 records the already authorized schema target and updates ADRs 0003, 0005 and 0032. These are design/documentation changes; they do not report completed code migration.

### F33. Project rows perform an N+1 session read

`buildProjectRowsCore` at `src/main/views.ts:142` calls `store.getSessions()` inside the loop over sources. Each call materializes and decodes the session rows again. `buildSessionSummaries` also rereads sources after queryScope already read them. Load both collections once and construct indexed provenance from the request snapshot. Session read count must remain constant as source count increases. The original store:views measurement did not measure this project route, so no duration or speedup is asserted.

### F34. Schema migration needs representation and boundary ownership

The committed ledger codecs map encoded keys, nullable values and JSON strings into domain values. The renderer helpers in `shared/lib/api.ts` currently accept `z.ZodType` and interpret Zod issue paths. `shared/schemas/renderer.ts` also has schemas used only for inferred UI types. Replacing each `z.*` call independently would miss consumer adapters and could apply transforms twice or introduce unnecessary validation of trusted UI values.

ADR 0034 requires one authority per contract, explicit Type/Encoded representation, dependency-ordered consumer conversion, typed backend decoding and synchronous renderer Result adapters. Stored-row, domain and wire shapes can differ while sharing reusable field definitions. Distinct trust boundaries still validate; repeated internal decoding of the same validated value should disappear.

### F35. Shell hydration forces full analytics and broad refresh

`applyChange` in `src/renderer/src/app/stores/scan-store.ts` awaits scan status, fetches full analytics for provider names, then notifies initialized Section stores. A fast config edit can therefore trigger several ledger queries even when most Sections are inactive. Reduce the analytics query's repeated backend reads. The owner rejected refresh coalescing and coordination variables; retain the original store implementation and assess actual IPC ordering. A small shell metadata query is a separately specified additive IPC contract, rather than a reinterpretation of store:analytics. Changing eager refresh to invalidation and on-demand reload requires reconciling ADR 0011.

### F36. A same-scope old response can overwrite newer data

`scopedDataSlice.load` in `src/renderer/src/app/stores/data-store.ts` checks only dataKey after awaiting fetch. Two loads for the same scope have the same key, so both may publish; the older request may resolve last. Scope guards correctly reject different-scope results but cannot distinguish refresh generations. This is a source-level limitation, not a reproduced failure under the actual IPC path. The owner rejected request identities and Promise ownership variables. Both production stores were restored to `ce81593` in `709207e`; preserve them and assess actual ordering before proposing further changes. The source-level limitation is not claimed fixed.

### F37. MCP high-level registration requires Zod shapes

The installed SDK declares `AnySchema = z3.ZodTypeAny | z4.$ZodType` in `server/zod-compat.d.ts`. Watchtower's `ledger-mcp/tools.ts` and `prompts.ts` expose ZodRawShape and the server registers those shapes directly. Shared overview/request schema conversion therefore needs an MCP adapter slice; Effect Schema is not accepted by that API merely because it implements Standard Schema.

Evaluate the official SDK Server handler API with SDK-owned protocol schemas, generated JSON Schema tool metadata, and Effect argument decoding. Preserve ADR 0020's official transport and complete tools/resources/prompts behavior. Require a concrete compatibility verdict before replacing registration. The SDK's own Zod dependency remains distinct from Watchtower-owned schemas: application migration can remove its direct contracts/imports without proving a Zod-free transitive package tree. The target architecture records both the dependency and its acceptance criteria.

## Implementation census, 2026-10-01

This source snapshot is `9fe7a15`. It adds view/model contracts, root-owned database initialization and direct-port dashboard/analytics queries to the preceding worker ownership, request pricing, cancellation and renderer decoder work. TypeScript AST import counting excludes type-only imports, declarations and test/spec files under `src`. Line coverage counts nonblank lines in importing files against nonblank area lines; it remains an upper bound on adoption, not a workflow completion percentage.

| Area                               | Files with Effect imports | File coverage | Lines in those files / area lines | Line coverage |
| ---------------------------------- | ------------------------: | ------------: | --------------------------------: | ------------: |
| DB worker                          |                     3 / 5 |         60.0% |                     1,260 / 1,370 |         92.0% |
| Store                              |                     8 / 9 |         88.9% |                     1,800 / 2,358 |         76.3% |
| Agents                             |                    8 / 44 |         18.2% |                     2,865 / 5,883 |         48.7% |
| Pipeline                           |                    5 / 68 |          7.4% |                    2,806 / 27,606 |         10.2% |
| View builders ending in `-view.ts` |                     2 / 8 |         25.0% |                       465 / 3,959 |         11.7% |
| All main-process code              |                  34 / 146 |         23.3% |                   11,480 / 45,079 |         25.5% |
| Shared schema modules              |                   13 / 24 |         54.2% |                     1,084 / 1,951 |         55.6% |
| Renderer                           |                   2 / 123 |          1.6% |                      436 / 13,111 |          3.3% |
| Preload                            |                     0 / 1 |          0.0% |                           0 / 217 |          0.0% |

Eleven of 23 baseline contract modules now use Effect Schema throughout: ledger, pipeline, providers, session-cache, port, cadence, fx, updates, export, models and views. That module measure is 47.8%, excluding the extraction helper. The renderer schema module additionally removes Zod in favor of plain TypeScript for UI-only types. Zod removal therefore covers 12/23 baseline modules, or 52.2%; this is a different measure from Effect Schema conversion. The broader 13/24 import count includes the extraction helper and partially migrated scan module. Renderer decoding remains synchronous, without an application runtime. Both original stores still match `ce81593`, with no request identities, coalescing or added `let` variables.

The pricing calculation module deliberately imports no runtime Effect value. Moving calculation out of the IO module reduces the pipeline's importing-line percentage. A request captures pricing once and shares it across aggregation and the Models lens. Provider adapters still capture from live state until scan-boundary inputs migrate. Dashboard and analytics now use a direct-port loader; other query callers retain the temporary facade loader. Query diagnostics and several pure helpers still enter through mixed legacy modules. Complete query/calculation separation remains open.

`41d5ea5` composes the actual worker SQLite client, repository ports and FX service under one ManagedRuntime. `67cb812` moves migration definitions and initialization into a shared module and runs it at the worker root before constructing the borrowed LedgerStore and publishing ready. Standalone writable compatibility callers use that same initializer; read-only callers skip DDL. Successful shutdown drains parser/callback and background work before the root scope closes the driver. Tests count actual SQLite close calls on success, future-version rejection, graph-build failure and context-construction failure. Repository spans reach the worker observation sink through the same graph.

`86215fd` supplies the canonical FX layer through LedgerConfig directly. SQL and Schema failures stay typed, while HTTP failures retain the existing fallback. Background FX failures are logged once using the existing bounded code field, without fetching or emitting a successful currency for a malformed cache. The temporary standalone runner adapter still turns synchronous failures into defects; delete it when its remaining test/standalone callers compose the canonical layer. Legacy currency response reads also remain until their application workflows migrate.

`1ac883d` forwards application and repository operation spans, omitting the SQL driver's per-statement `sql.execute` records. Suppressed spans still end normally. Timing and sanitized failure codes remain on enclosing operations. The writer, quota and privacy allowlist are unchanged.

`9fe7a15` loads six facts/config collections inside one SQL transaction and decodes the materialized rows after commit. Dashboard and analytics application Effects validate their output once and preserve typed SQL/Schema failures. Tests require one snapshot port call, forbid facade bulk reads, compare seeded payloads, exercise config freshness without a rescan, and check expected failures. Six SELECTs remain; transaction control adds statements for consistency. No SQL reduction or post-migration speedup is claimed.

`fc0315e` converts view/model contracts and their producer/renderer consumers together. Frozen prior contracts compare strict decoded values, absent and explicit undefined properties, nullable fields, extension stripping and NaN/infinite values. Mutable schema fields and arrays preserve consumer behavior; model aliases and price overrides reuse ledger authority. UI-only renderer types require no runtime schemas.

The target architecture's execution record records integration evidence. Full contract migration, remaining application queries and protocol failure mapping, facade retirement, bounded parser stop, purpose-specific queries, packaging and comparable performance measurements remain open. The static module graph still connects application queries to mixed legacy modules; it is not yet the completed clean architecture.
