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

At the assessment baseline, [PR #147](https://github.com/Pasquale-Favella/watchtower/pull/147) described a narrow migration foundation and contained `Closes #148`. Its September 24 rollout comment also said work was complete. The current PR description and living assessment now track the expanded programme and leave #148 open.

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

`scopedDataSlice.load` in `src/renderer/src/app/stores/data-store.ts` checks only dataKey after awaiting fetch. Two loads for the same scope have the same key, so both may publish; the older request may resolve last. Scope guards correctly reject different-scope results but cannot distinguish refresh generations. The owner rejected request identities and Promise ownership variables. Both production stores were restored to `ce81593` in `709207e`; preserve them.

`d68fda9` adds a controlled native ordering check using a real worker, SQLite root, worker context and dashboard application query. A test-only Deferred pauses delivery after the real snapshot transaction has completed. A price write then commits and emits `config:changed`. A subsequent identical client read joins the old Promise and sends no second request. The old response arrives after the event with its earlier cost; a later request obtains the new cost. This reproduces stale coalescing under that barrier. It does not establish ordinary synchronous-adapter overlap, full Electron relay ordering or an older view overwriting a newer completed view. F35/F36 remain open, with no production ordering change.

### F37. MCP high-level registration requires Zod shapes

The installed SDK declares `AnySchema = z3.ZodTypeAny | z4.$ZodType` in `server/zod-compat.d.ts`. Watchtower's `ledger-mcp/tools.ts` and `prompts.ts` expose ZodRawShape and the server registers those shapes directly. Shared overview/request schema conversion therefore needs an MCP adapter slice; Effect Schema is not accepted by that API merely because it implements Standard Schema.

Evaluate the official SDK Server handler API with SDK-owned protocol schemas, generated JSON Schema tool metadata, and Effect argument decoding. Preserve ADR 0020's official transport and complete tools/resources/prompts behavior. Require a concrete compatibility verdict before replacing registration. The SDK's own Zod dependency remains distinct from Watchtower-owned schemas: application migration can remove its direct contracts/imports without proving a Zod-free transitive package tree. The target architecture records both the dependency and its acceptance criteria.

## Implementation census, 2026-10-02

This snapshot is `d68fda9`, with production changes through `4896421`. It includes six further section contracts and the internal resume cursor conversion, in addition to the preceding pure queries and worker recovery increment. TypeScript AST import counting excludes type-only imports, declarations and test/spec files under `src`. Line coverage counts nonblank lines in importing files against nonblank area lines; it remains an upper bound on adoption, not a workflow completion percentage.

| Area                               | Files with Effect imports | File coverage | Lines in those files / area lines | Line coverage |
| ---------------------------------- | ------------------------: | ------------: | --------------------------------: | ------------: |
| DB worker                          |                     3 / 5 |         60.0% |                     1,436 / 1,546 |         92.9% |
| Store                              |                   10 / 12 |         83.3% |                     1,799 / 2,413 |         74.6% |
| Agents                             |                   10 / 44 |         22.7% |                     3,589 / 5,884 |         61.0% |
| Pipeline                           |                    6 / 73 |          8.2% |                    2,636 / 27,610 |          9.5% |
| View builders ending in `-view.ts` |                     8 / 8 |        100.0% |                     3,967 / 3,967 |        100.0% |
| All main-process code              |                  47 / 156 |         30.1% |                   16,064 / 45,369 |         35.4% |
| Shared schema modules              |                   21 / 24 |         87.5% |                     1,571 / 1,998 |         78.6% |
| Renderer                           |                   2 / 123 |          1.6% |                      454 / 13,129 |          3.5% |
| Preload                            |                     0 / 1 |          0.0% |                           0 / 217 |          0.0% |

Twenty of 23 baseline contract modules now use Effect Schema throughout, 87.0%. The six additions are spend, compare, optimize, yield, skills and pull-requests. Overview and agents remain on Zod. The renderer schema module additionally removes Zod in favor of plain TypeScript for UI-only types, so Zod removal covers 21/23 baseline modules, 91.3%. The broader 21/24 import count includes the extraction helper. All eight view-builder modules now import Effect Schema for boundary validation; their 100% import coverage does not prove pure calculation separation, direct-port application loading or facade retirement. Renderer decoding remains synchronous, without an application runtime. Both original stores still match `ce81593`, with no request identities, coalescing or added `let` variables. MCP tool registration, temporary decoder adapters, frozen parity references and the direct dependency still need removal.

The pricing calculation module deliberately imports no runtime Effect value. Moving calculation out of the IO module reduces the pipeline's importing-line percentage. A request captures pricing and proxy configuration once. Dashboard and analytics import pure calculations and focused ledger ports; their unpriced-model reporting uses a port supplied at the worker root. Import-graph tests forbid IO, repository implementations and Effect runtime imports in the pure calculation graph. Other query callers retain the temporary facade loader. Provider adapters still capture live pricing state until scan-boundary inputs migrate.

`41d5ea5` composes the actual worker SQLite client, repository ports and FX service under one ManagedRuntime. `67cb812` moves migration definitions and initialization into a shared module and runs it at the worker root before constructing the borrowed LedgerStore and publishing ready. Standalone writable compatibility callers use that same initializer; read-only callers skip DDL. Successful shutdown drains parser/callback and background work before the root scope closes the driver. Tests count actual SQLite close calls on success, future-version rejection, graph-build failure and context-construction failure. Repository spans reach the worker observation sink through the same graph.

`86215fd` supplies the canonical FX layer through LedgerConfig directly. SQL and Schema failures stay typed, while HTTP failures retain the existing fallback. Background FX failures are logged once using the existing bounded code field, without fetching or emitting a successful currency for a malformed cache. The temporary standalone runner adapter still turns synchronous failures into defects; delete it when its remaining test/standalone callers compose the canonical layer. Legacy currency response reads also remain until their application workflows migrate.

`1ac883d` forwards application and repository operation spans, omitting the SQL driver's per-statement `sql.execute` records. Suppressed spans still end normally. Timing and sanitized failure codes remain on enclosing operations. The writer, quota and privacy allowlist are unchanged.

`9fe7a15` loads six facts/config collections inside one SQL transaction and decodes the materialized rows after commit. Dashboard and analytics application Effects validate their output once and preserve typed SQL/Schema failures. Tests require one snapshot port call, forbid facade bulk reads, compare seeded payloads, exercise config freshness without a rescan, and check expected failures. Six SELECTs remain; transaction control adds statements for consistency. No SQL reduction or post-migration speedup is claimed.

`fc0315e` converts view/model contracts and their producer/renderer consumers together. Frozen prior contracts compare strict decoded values, absent and explicit undefined properties, nullable fields, extension stripping and NaN/infinite values. Mutable schema fields and arrays preserve consumer behavior; model aliases and price overrides reuse ledger authority. UI-only renderer types require no runtime schemas.

`8b1859f` bounds the host's cooperative scan-abort wait to two seconds. On expiry it waits for actual thread termination before booting a replacement, gates requests on replacement readiness and rejects failed recovery. Tests cover interruption, defects, boot failure, shutdown races and a real worker whose delayed callback must neither write nor emit progress. Forced thread termination does not prove cooperative parser cleanup or execution of Effect finalizers. Those remain acceptance work.

The target architecture's execution record records integration evidence. Full contract migration, remaining application queries and protocol failure mapping, facade retirement, cooperative parser stop, purpose-specific queries, packaging and comparable performance measurements remain open. Pure dashboard/analytics separation is implemented; the remaining product paths still require migration.

## Current census after owned schema removal, 2026-10-02

This snapshot is `5b4233b`, with production and test changes through `43d5b90`. It uses the same TypeScript AST runtime-import and nonblank-line method as the preceding census. Import coverage remains an upper bound on adoption, not workflow completion.

| Area                               | Files with Effect imports | File coverage | Lines in those files / area lines | Line coverage |
| ---------------------------------- | ------------------------: | ------------: | --------------------------------: | ------------: |
| DB worker                          |                     4 / 6 |         66.7% |                     1,498 / 1,608 |         93.2% |
| Store                              |                   10 / 12 |         83.3% |                     1,799 / 2,413 |         74.6% |
| Agents                             |                   12 / 44 |         27.3% |                     3,873 / 5,889 |         65.8% |
| Pipeline                           |                    6 / 73 |          8.2% |                    2,636 / 27,610 |          9.5% |
| View builders ending in `-view.ts` |                     8 / 8 |        100.0% |                     3,967 / 3,967 |        100.0% |
| All main-process code              |                  51 / 157 |         32.5% |                   17,095 / 45,439 |         37.6% |
| Shared schema modules              |                   23 / 24 |         95.8% |                     1,865 / 1,923 |         97.0% |
| Renderer                           |                   2 / 123 |          1.6% |                      379 / 13,053 |          2.9% |
| Preload                            |                     0 / 1 |          0.0% |                           0 / 217 |          0.0% |

Native Effect Schema now covers 22/23 baseline contract modules, 95.7%. Including the UI-only plain TypeScript module, owned Zod removal covers 23/23, 100%. The broader 23/24 import count includes the extraction helper. All owned contracts and their consumers have left Zod; the renderer helpers now accept native Schema directly. Recorded literal parity expectations replace the frozen Zod fixtures, and an AST/dependency guard enforces the removal. The official MCP adapter decodes Effect inputs and generates their advertised metadata, retaining SDK-owned protocol schemas and transport behavior. Transitive SDK Zod is not an owned contract.

F32 now has bounded worker request/init failure mapping for typed SQL, Schema and unsupported-version failures. Real runner and native worker checks cover those paths. Main/Coach failure mapping and remaining synchronous facade boundaries still prevent calling F32 complete. F37's owned argument-schema adapter is implemented and covered with real SDK clients over isolated stdio streams and loopback HTTP. Windows directory packaging and a real packaged stdio child also pass: six tools, metadata, invalid/unknown tool errors, three resources, the prompt and SDK shutdown. This does not establish macOS/Linux packaged execution or installer acceptance.

Both renderer stores remain byte-identical to `ce81593`. The owner rejected request identities, coalescing and added mutable coordination in those files. F35/F36 retain their earlier controlled native ordering evidence and limitations. The remaining application queries, facade retirement, captured time/scan inputs, cooperative parser stop, purpose-specific reads, main/Coach ownership, complete packaging acceptance and comparable performance measurements remain open. No performance claim is made.

## Current census after scoped query migration, 2026-10-02

This snapshot covers production source `0f823d3`. The same TypeScript AST runtime-import and nonblank-line method measures import coverage. Moving pure calculations out of Effect-importing files lowers line coverage while application ownership advances.

| Area                               | Files with Effect imports | File coverage | Lines in those files / area lines | Line coverage |
| ---------------------------------- | ------------------------: | ------------: | --------------------------------: | ------------: |
| DB worker                          |                     4 / 6 |         66.7% |                     1,511 / 1,621 |         93.2% |
| Store                              |                   10 / 12 |         83.3% |                     1,803 / 2,417 |         74.6% |
| Agents                             |                   12 / 44 |         27.3% |                     3,873 / 5,889 |         65.8% |
| Pipeline                           |                    6 / 73 |          8.2% |                    2,554 / 27,600 |          9.3% |
| View builders ending in `-view.ts` |                     8 / 8 |        100.0% |                     3,549 / 3,549 |        100.0% |
| All main-process code              |                  54 / 164 |         32.9% |                   16,056 / 45,566 |         35.2% |
| Shared schema modules              |                   23 / 24 |         95.8% |                     1,865 / 1,923 |         97.0% |
| Renderer                           |                   2 / 123 |          1.6% |                      379 / 13,053 |          2.9% |
| Preload                            |                     0 / 1 |          0.0% |                           0 / 217 |          0.0% |

Named application queries now cover 5/11 aggregate and dedicated section read paths, 45.5%: dashboard, analytics, Sessions, Models and Overview. Scoped dedicated queries cover 3/9, 33.3%. The denominator includes Overview, Sessions, Pull Requests, Spend, Models, Compare, Optimize, Yield and Skills, plus dashboard and analytics. These counts measure this particular query boundary, not the whole migration.

Owned Zod removal remains 23/23 baseline modules, 100%; native Effect Schema covers 22/23, 95.7%, with one UI-only plain TypeScript module. F29 remains partial because other application queries, compatibility callers and purpose-specific reads are still open. The three new queries capture request time once before awaiting a snapshot and use pure calculations over captured pricing inputs. Models removes two separate config reads by reusing the alias and override rows already in that snapshot. Six snapshot SELECTs remain unchanged; comparable speed, memory and IPC measurements remain outstanding.

Other remaining work includes scan-boundary inputs, cooperative parser stop and callback draining, main/Coach ownership and mapping, full facade retirement, installer acceptance and macOS/Linux packaged execution. Both renderer stores still match `ce81593` exactly.

## Current census after Spend, Compare and Pull Requests migration, 2026-10-02

This snapshot covers production source `979b73e`. It uses the same TypeScript AST runtime-import and nonblank-line method as the previous census. Import coverage measures library use, not completion of the migration.

| Area                               | Files with Effect imports | File coverage | Lines in those files / area lines | Line coverage |
| ---------------------------------- | ------------------------: | ------------: | --------------------------------: | ------------: |
| DB worker                          |                     4 / 6 |         66.7% |                     1,518 / 1,628 |         93.2% |
| Store                              |                   10 / 12 |         83.3% |                     1,803 / 2,417 |         74.6% |
| Agents                             |                   12 / 44 |         27.3% |                     3,873 / 5,889 |         65.8% |
| Pipeline                           |                    6 / 74 |          8.1% |                    2,554 / 27,637 |          9.2% |
| View builders ending in `-view.ts` |                     8 / 8 |        100.0% |                     3,000 / 3,000 |        100.0% |
| All main-process code              |                  57 / 171 |         33.3% |                   15,587 / 45,676 |         34.1% |
| Shared schema modules              |                   23 / 24 |         95.8% |                     1,865 / 1,923 |         97.0% |
| Renderer                           |                   2 / 123 |          1.6% |                      379 / 13,053 |          2.9% |
| Preload                            |                     0 / 1 |          0.0% |                           0 / 217 |          0.0% |

Named application queries cover 8/11 aggregate and dedicated section read paths, 72.7%: dashboard, analytics, Overview, Sessions, Models, Spend, Compare and Pull Requests. Scoped dedicated queries cover 6/9, 66.7%. Optimize, Yield and Skills remain outside that query boundary because their workflows also use filesystem or process IO.

The new queries capture request time once before loading one canonical snapshot. Their calculations use the snapshot's captured pricing catalogue, with diagnostics reported once and output validation in the typed error channel. PR attribution is now a pure module; terminal/report compatibility exports remain available. Spend uses the catalogue already in the snapshot, with no duplicate catalogue parameter. Compare preserves raw model identity and requested pair behavior.

Owned Zod removal remains 23/23 baseline modules, 100%; native Effect Schema remains 22/23, 95.7%, with one UI-only plain TypeScript module. Six snapshot SELECTs remain unchanged. Forty-one worker checks cover the eight read paths and explicit Compare pair forwarding. Pure import-graph and narrow-column audits cover all new calculation modules. No speedup or memory improvement is claimed.

F29 remains partial. Remaining work includes the three IO-dependent section queries, other application queries and compatibility callers, facade retirement, purpose-specific reads, scan-boundary input capture, cooperative parser stop and callback drain, main/Coach ownership and error mapping, comparable 1k/50k/500k measurements, installer acceptance and macOS/Linux packaged execution. Both renderer stores remain byte-identical to `ce81593`, with no added `let` variables, request identities or applyChange coalescing.

## Current census after Skills, Yield and Optimize migration, 2026-10-05

This snapshot covers production and test source `249db58`, following `426dfd7`. It uses the same TypeScript AST runtime-import and nonblank-line method. Import coverage measures library use; it does not measure completion of the migration.

| Area                               | Files with Effect imports | File coverage | Lines in those files / area lines | Line coverage |
| ---------------------------------- | ------------------------: | ------------: | --------------------------------: | ------------: |
| DB worker                          |                     4 / 6 |         66.7% |                     1,518 / 1,628 |         93.2% |
| Store                              |                   10 / 12 |         83.3% |                     1,803 / 2,417 |         74.6% |
| Agents                             |                   12 / 44 |         27.3% |                     3,873 / 5,889 |         65.8% |
| Pipeline                           |                    6 / 74 |          8.1% |                    2,554 / 27,637 |          9.2% |
| View builders ending in `-view.ts` |                     8 / 8 |        100.0% |                         380 / 380 |        100.0% |
| All main-process code              |                  64 / 182 |         35.2% |                   13,609 / 46,101 |         29.5% |
| Shared schema modules              |                   23 / 24 |         95.8% |                     1,868 / 1,926 |         97.0% |
| Renderer                           |                   2 / 123 |          1.6% |                      379 / 13,053 |          2.9% |
| Preload                            |                     0 / 1 |          0.0% |                           0 / 217 |          0.0% |

Named application queries now cover **11/11 aggregate and dedicated section read paths, 100%**. Scoped dedicated queries cover **9/9, 100%**. The denominator is unchanged: dashboard and analytics, plus Overview, Sessions, Pull Requests, Spend, Models, Compare, Optimize, Yield and Skills. These percentages describe worker query ownership only. Other reads, writes, compatibility builders and MCP facade callers remain.

Skills and Optimize share an AssistantSetup capability composed in the existing worker root. Setup files and shell profiles are captured once per request and reused across Optimize detectors. Skills obtains inventory and current dismissals explicitly. Yield uses a RepositoryInspection capability over the existing CommandRunner, with scoped child cleanup, a five-second limit per Git command and a one-mebibyte stdout limit. Operational inspection failures retain the previous partial or empty facts policy; defects remain failures. Repository identity deduplicates Git facts across related project directories.

Each new query captures the Clock once before loading one canonical ledger snapshot, reports pricing diagnostics once and validates its output through Effect Schema. Calculation modules have no runtime Effect or filesystem/process imports. The import census therefore records fewer lines in modules importing Effect after pure detector extraction. All 16 Optimize detectors remain; 56 extracted helper bodies are mechanically identical to the baseline, and seven discovery-dependent helpers now consume explicit setup facts.

Owned Zod removal remains **23/23 baseline modules, 100%**; native Effect Schema remains **22/23, 95.7%**, with one UI-only plain TypeScript module. Fifty-eight worker checks cover all eleven reads, including current Skills dismissals, invalid threshold fallback, live configuration edits, one snapshot and typed SQL/Schema failures. Six snapshot SELECTs remain unchanged. No SQL reduction, speedup or memory improvement is claimed.

F29 remains partial. Remaining work includes other application queries, facade and compatibility adapter retirement, purpose-specific reads, scan-boundary input capture, cooperative parser stop and callback drain, main/Coach ownership and failure mapping, comparable 1k/50k/500k measurements including refresh/detail/search, installer acceptance and macOS/Linux packaged execution. Both renderer stores remain byte-identical to `ce81593`, with no added `let` variables, request identities or applyChange coalescing.

## Current census after export and lifetime ownership migration, 2026-10-05

This snapshot covers production and test source `88ca75b`, following `e553601`. The TypeScript AST runtime-import and nonblank-line method is unchanged. These are library import percentages, not architectural completion percentages.

| Area                               | Files with Effect imports | File coverage | Lines in those files / area lines | Line coverage |
| ---------------------------------- | ------------------------: | ------------: | --------------------------------: | ------------: |
| DB worker                          |                     4 / 6 |         66.7% |                     1,506 / 1,616 |         93.2% |
| Store                              |                   10 / 12 |         83.3% |                     1,803 / 2,417 |         74.6% |
| Agents                             |                   12 / 44 |         27.3% |                     3,802 / 5,818 |         65.3% |
| Pipeline                           |                    7 / 75 |          9.3% |                    2,587 / 27,818 |          9.3% |
| View builders ending in `-view.ts` |                     8 / 8 |        100.0% |                         380 / 380 |        100.0% |
| All main-process code              |                  68 / 188 |         36.2% |                   13,675 / 46,344 |         29.5% |
| Shared schema modules              |                   23 / 24 |         95.8% |                     1,868 / 1,926 |         97.0% |
| Renderer                           |                   2 / 123 |          1.6% |                      379 / 13,053 |          2.9% |
| Preload                            |                     0 / 1 |          0.0% |                           0 / 217 |          0.0% |

The established section-query denominator remains 11/11, 100%, with scoped dedicated queries 9/9, 100%. Export now separately covers both CSV and JSON routes, 2/2, through one named application query in the existing worker runtime. Each export reads one full-history snapshot and captures currency once after the no-data guard, before file IO. Pure builders receive currency and generation time explicitly. The next request sees configuration edits. File failures map to bounded guidance; SQL and Schema failures remain typed. Compatibility export wrappers remain for test callers with an explicit removal condition.

Main now composes the actual app-version-aware probe and scoped snapshot in its one runtime. IPC enters that runtime, and root disposal owns pending detection and probe fibers. Quit awaits Coach cleanup, main-runtime disposal and worker shutdown before closing the operational log and permitting Electron to exit. These changes complete that ownership slice; main/Coach failure mapping and other service adoption remain open.

F31 remains partial. Each scan owns an AbortSignal before parser work begins; interruption signals stop before awaiting the actual parser/callback drain. Parser checkpoints preserve cancellation through file-isolation catches and prevent new callbacks or cache publication after stop. Claude line streams accept the signal and close in their finalizer. Provider factories still do not accept a signal, so a generator blocked in `next()` or a noncooperative producer can hold draining indefinitely. The existing two-second host recovery remains necessary. Vercel Gateway network work and Codex/Copilot file readers are concrete follow-up producers.

Owned Zod removal remains 23/23 baseline modules, 100%; native Effect Schema remains 22/23, 95.7%, with one UI-only plain TypeScript module. The six canonical snapshot SELECTs are unchanged. No speedup, SQL reduction or memory improvement is claimed. Other application queries, purpose-specific detail/search reads, persistent MCP read-only root adoption, compatibility facade retirement, one pricing catalogue per scan, main/Coach failure mapping, comparable 1k/50k/500k measurements and installer/macOS/Linux packaged acceptance remain open.

Both renderer stores remain byte-identical to `ce81593`. Their original scope key and direct applyChange flow are preserved, without added `let` variables, request IDs or coalescing.

## Current census after captured scan pricing, 2026-10-05

This snapshot covers production and test source `4638bfa`, following `2f504fa`. The TypeScript AST runtime-import and nonblank-line method is unchanged. Import percentages measure library use, not architectural completion.

| Area                               | Files with Effect imports | File coverage | Lines in those files / area lines | Line coverage |
| ---------------------------------- | ------------------------: | ------------: | --------------------------------: | ------------: |
| DB worker                          |                     4 / 6 |         66.7% |                     1,515 / 1,625 |         93.2% |
| Store                              |                   10 / 12 |         83.3% |                     1,809 / 2,423 |         74.7% |
| Agents                             |                   12 / 44 |         27.3% |                     3,802 / 5,818 |         65.3% |
| Pipeline                           |                    8 / 77 |         10.4% |                    2,689 / 28,688 |          9.4% |
| View builders ending in `-view.ts` |                     8 / 8 |        100.0% |                         380 / 380 |        100.0% |
| All main-process code              |                  71 / 192 |         37.0% |                   13,836 / 47,273 |         29.3% |
| Shared schema modules              |                   23 / 24 |         95.8% |                     1,868 / 1,926 |         97.0% |
| Renderer                           |                   2 / 123 |          1.6% |                      379 / 13,053 |          2.9% |
| Preload                            |                     0 / 1 |          0.0% |                           0 / 217 |          0.0% |

Captured scan pricing now covers all 32/32 provider modules that previously called the live cost calculator, 100% of that fixed producer denominator. An AST comparison against `2f504fa` finds 47/47 cost calls with unchanged ordered billing argument expressions. This is separate from Effect import coverage. Pure price arithmetic remains ordinary TypeScript.

The scan captures one catalogue, aliases, overrides and local savings map after loading pricing. Discovery, provider factories, Claude call/advisor grouping, cached call reconstruction and ledger ingest use that capture. A real worker/SQLite test changes pricing and the savings mapping while repository lookup waits, verifies the same pricing identity reaches ingest, and checks persisted old costs and savings. The next scan observes the edits. Recorded cost, including zero, retains its previous precedence; cache hits retain their previously recorded base cost.

Actual provider fixtures verify explicit scan pricing, factory capture before IO and next-factory freshness. They cover file, SQLite, binary generator metadata and local RPC routes. The Antigravity fixture also exposed a native database leak when its optional workspace table was absent. The lookup now closes in finally before falling back, with matching real open/close assertions and successful native Windows directory cleanup.

Direct standalone factory, parser-helper and ingest callers still have capture defaults. Remove those compatibility defaults after every direct caller supplies the scan-owned capture. The removal condition is documented on ProviderScanServices and captureScanPricing.

Section-query ownership remains 11/11, 100%; scoped dedicated queries remain 9/9, 100%; export remains a separate 2/2 route slice. Owned Zod removal remains 23/23 baseline modules, 100%; native Effect Schema remains 22/23 baseline modules, 95.7%, with one UI-only plain TypeScript module. The Gateway Schema is outside that baseline denominator. Six canonical snapshot SELECTs remain unchanged. No speedup, SQL reduction or memory improvement is claimed.

F31 remains partial for other provider IO. Cooperative Codex/Copilot streams and Gateway fetch/body work retain their stop/drain checks; filesystem operations without native cancellation and synchronous SQLite statements still drain before checkpoints can stop further work. Existing host recovery remains.

Other application queries, purpose-specific detail/search reads, persistent MCP query ownership, facade and compatibility retirement, main/Coach failure mapping, comparable 1k/50k/500k measurements, installer acceptance and macOS/Linux packaged execution remain open. Both renderer stores remain byte-identical to `ce81593`, without added let variables, request identities or applyChange coalescing. Full verification and exact-head CI evidence are maintained in the living issue #148 assessment.

## Current census after MCP query ownership, 2026-10-06

This snapshot covers production and test source `76ddfc6`, following `6923063`. The TypeScript AST runtime-import and nonblank-line method is unchanged. These percentages measure library imports, not architectural completion. Pure calculations remain ordinary TypeScript.

| Area                               | Files with Effect imports | File coverage | Lines in those files / area lines | Line coverage |
| ---------------------------------- | ------------------------: | ------------: | --------------------------------: | ------------: |
| DB worker                          |                     4 / 6 |         66.7% |                     1,515 / 1,625 |         93.2% |
| Store                              |                   10 / 12 |         83.3% |                     1,809 / 2,423 |         74.7% |
| Agents                             |                   14 / 46 |         30.4% |                     3,993 / 5,898 |         67.7% |
| Pipeline                           |                    8 / 77 |         10.4% |                    2,689 / 28,688 |          9.4% |
| View builders ending in `-view.ts` |                     8 / 8 |        100.0% |                         380 / 380 |        100.0% |
| All main-process code              |                  74 / 196 |         37.8% |                   14,083 / 47,491 |         29.7% |
| Shared schema modules              |                   24 / 25 |         96.0% |                     1,903 / 1,961 |         97.0% |
| Renderer                           |                   2 / 123 |          1.6% |                      379 / 13,053 |          2.9% |
| Preload                            |                     0 / 1 |          0.0% |                           0 / 217 |          0.0% |

MCP tools now use named application queries, 6/6, and query-backed resources use those queries when read, 2/2. Both stdio and HTTP share one persistent read-only runtime per process. The SDK remains responsible for protocol framing, request validation and transports; only application arguments and payloads use Watchtower's Effect Schemas. The third resource remains static schema documentation.

Models reuses aliases and price overrides in its snapshot. Instrumented native SELECT execution counts six statements on both cold and warm requests, versus eight in the legacy path. The canonical snapshot still has six reads. No broad latency or memory gain is claimed. Fresh external edits and schema/read failures are tested; scoped transports close before their borrowed runtime is disposed.

Section-query ownership remains 11/11, scoped dedicated queries 9/9, and export routes 2/2. Captured scan pricing remains 32/32 producer modules with 47/47 billing argument expressions preserved. Owned Zod removal remains 23/23 baseline modules, 100%; native Effect Schema remains 22/23, 95.7%, with one UI-only plain TypeScript module. Gateway and MCP result schemas are outside that baseline denominator.

Final focused verification passes 56 tests across six files, including nine lifetime tests. The final review fixed ineffective cleanup recovery around Effect.promise and direct EOF stop signaling. Node/web and strict test types, full formatting and the production build pass. Lint has zero errors and 1,104 advisory warnings. The final full unit suite passes 166 files, with 2,292 passed and two skipped in 219.98 seconds, one worker and unchanged existing assertions/timeouts. Packaging and exact-head CI evidence are maintained in the [living assessment](https://github.com/Pasquale-Favella/watchtower/issues/148#issuecomment-5913654224).

Remaining work includes the four worker compatibility reads, purpose-specific detail/search SQL, commands, facade and compatibility retirement, cooperative provider IO, main/Coach failure mapping, comparable scaled measurements and installer/macOS/Linux packaged acceptance. Both renderer stores remain byte-identical to `ce81593`. Issue #148 remains open.

## Current census after focused session queries, 2026-10-06

This snapshot covers production and test source `32fafe8`, following `05d56de`. The TypeScript AST runtime-import/nonblank-line method is unchanged. These percentages measure library imports, not architectural completion. Pure calculations remain ordinary TypeScript.

| Area                               | Files with Effect imports | File coverage | Lines in those files / area lines | Line coverage |
| ---------------------------------- | ------------------------: | ------------: | --------------------------------: | ------------: |
| DB worker                          |                     4 / 6 |         66.7% |                     1,514 / 1,624 |         93.2% |
| Store                              |                   12 / 14 |         85.7% |                     2,067 / 2,658 |         77.8% |
| Agents                             |                   14 / 46 |         30.4% |                     4,012 / 5,917 |         67.8% |
| Pipeline                           |                    8 / 77 |         10.4% |                    2,689 / 28,691 |          9.4% |
| View builders ending in `-view.ts` |                     8 / 8 |        100.0% |                         380 / 380 |        100.0% |
| All main-process code              |                  79 / 205 |         38.5% |                   14,261 / 48,076 |         29.7% |
| Shared schema modules              |                   24 / 25 |         96.0% |                     1,903 / 1,961 |         97.0% |
| Renderer                           |                   2 / 123 |          1.6% |                      379 / 13,053 |          2.9% |
| Preload                            |                     0 / 1 |          0.0% |                           0 / 217 |          0.0% |

The four previously compatible worker read routes now use named application queries, 4/4. `LedgerSessionReads` provides focused summary, targeted detail and text-search facts through the existing worker SQL root. Projects/session rows execute five SELECTs, detail six filtered SELECTs, and search four on both cold and warm requests. Blank search executes zero. The previous builders used six full snapshot reads. Smaller projections and fewer statements are verified; broad speed or memory gains remain unmeasured.

The new calculations preserve canonical project/source identity, whole-turn admission, first matching public session ID, query-time pricing, optional fields, model provenance, date/order rules, first-hit search and its 500 limit. Their four production compatibility builders are retired, and all test callers use the application queries. A test-only baseline reference and hardcoded payload assertions provide parity evidence. The separate project-summary adapter and synchronous ledger facade remain until their callers migrate.

Expected harness probe failures now have bounded messages and an explicit error tag. Defects and interruption retain their failure causes. Main-owned probe lifetime, status/auth/version fields and known sign-out behavior remain.

Section-query ownership remains 11/11, scoped dedicated queries 9/9, export routes 2/2 and MCP tools/data resources 6/6 and 2/2. Captured scan pricing remains 32/32 producers with 47/47 billing arguments preserved. Owned Zod removal remains 23/23 baseline modules, 100%; native Effect Schema remains 22/23, 95.7%, with one UI-only plain TypeScript module.

Final focused verification passes 160 tests across 14 files. Node/web and strict test types, full formatting and build pass. Lint has zero errors and 1,099 advisory warnings. Final reviews have no blocking findings. Full verification and published-head evidence are maintained in the living assessment.

The programme remains open for commands, facade/compatibility retirement, cooperative provider IO, Coach failure mapping, comparable scaled measurements and installer/macOS/Linux packaged acceptance. Both renderer stores remain byte-identical to `ce81593`, without added let variables, request IDs or applyChange coalescing.

The final full unit suite passes 170 files, with 2,325 passed and two skipped in 209.63 seconds, one worker and unchanged existing assertions/timeouts. Electron, fresh Windows packaging, actual packaged IPC/MCP and published-head CI evidence are maintained in the living assessment after terminal results are inspected.
