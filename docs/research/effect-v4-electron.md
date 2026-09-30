# Effect v4 × Electron: external references verified against rc.115

> Research note, 2026-09-29. Companion to
> [`docs/plans/effect-adoption.md`](../plans/effect-adoption.md), which measured
> our tree; this one takes the external references and checks them against the
> installed source. Live discussion: [#148](https://github.com/Pasquale-Favella/watchtower/issues/148).

That plan measured our tree — it is "Part I" wherever this note says so. This one takes the seven external references (Effect + Electron
reference architectures, Effect service/layer docs, and two general Electron
layering guides) and checks **every claim against the `effect@4.0.0-rc.115`
source actually installed in `node_modules/effect/src`**, then maps what survives
onto our measured gaps.

Method note: the addendum correctly warns that "most of what follows is
v3-era." I read `node_modules/effect/src/*.ts` rather than the docs, because
`docs/agents/effect.md` already mandates exactly that, and because the
`AGENTS.md` claim "`Effect.fn` names create tracing spans" and the
`Schedule.min` / `LogLevel` / `Fiber` renames are v4-only behaviours that no
v3-era article will describe correctly.

---

## 1. Every addendum claim, adjudicated

| #   | Claim                                                                                                                                                                                                        | rc.115 reality (verified in `node_modules/effect/src`)                                                                                                                                                              | Verdict                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | electron-effect-starter: "main process, server, client transport are all Effect programs… one Layer graph, scoped cleanup, supervised backend health-checked before the window shows, restarts with backoff" | `Layer.build`, `Layer.launch`, `Layer.unwrap`, `Layer.effectDiscard`, `Layer.fresh` all exist (`Layer.ts`)                                                                                                          | **Adopt the Layer graph + `Layer.launch`.** We have 0 uses of `Layer.launch`/`Layer.effectDiscard`.                                                                                                                                                                                                                                                                      |
| 1b  | "supervised backend, health-checked before the window shows, restarts with backoff"                                                                                                                          | Already implemented, and ahead of the reference                                                                                                                                                                     | **Already done.** `DbWorkerClient` (`client.ts:157-211`): never-lived-never-respawn, post-ready crash streak, capped exponential + jittered backoff, 60s quiet reset, no in-flight replay, `Effect.ensuring` termination, in-flight rejection on crash. ADR 0023's topology is better than the reference architecture.                                                   |
| 2   | T3 Code: "schema-only contracts package with Effect/Schema definitions, no runtime logic"                                                                                                                    | `Schema.toStandardSchemaV1` exists (`Schema.ts:1339`) — Effect Schema can _emit_ a Standard Schema. There is **no** `Schema.fromStandardSchemaV1` and 0 read-side occurrences of `"~standard"` outside that emitter | **Cannot adopt, and this validates our lock.** Zod 4 is Standard-Schema-native, but rc.115 cannot ingest a Standard Schema. The only way to get Effect-Schema contracts on the wire is to replace Zod, which `docs/architecture.md` and ADR 0032 forbid. **The addendum's most-cited pattern is the one we must decline — for a reason the Zod lock already implied.**   |
| 2b  | T3 Code: "renderer connects to the backend over WebSocket"                                                                                                                                                   | n/a                                                                                                                                                                                                                 | **Decline.** We own a dedicated `worker_threads` isolate (ADR 0023). A loopback HTTP hop would add a serialization hop and a port to a single-machine, local-first app (ADR 0012).                                                                                                                                                                                       |
| 3   | pi-desktop: "main process in Effect behind a thin typed `contextBridge` preload"                                                                                                                             | Already the shape                                                                                                                                                                                                   | **Already done.** `src/preload`, `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` (`index.ts:436-448`). Nothing to take.                                                                                                                                                                                                                              |
| 4   | Effect docs, "Managing Services" (v3-era page)                                                                                                                                                               | v4 differences we already honour: `Context.Service<Self, Shape>()('pkg/path/Name')` identifier (all 7 of ours have it), `Effect.fn('name')` emits a span (not just a wrapper), `Fiber` is a top-level module        | **Our practice is already v4-correct.** The article's advice is sound; no correction needed.                                                                                                                                                                                                                                                                             |
| 5   | DEV.to: "separate each domain into models / repositories / infrastructure / services, wire with `Layer.provide` in an entry point"                                                                           | v4: `Context.Service` + `Layer.effect` + `Layer.provideMerge`; `SqlModel.makeRepository` / `SqlModel.makeResolvers` (`unstable/sql/SqlModel.ts`) generate the repository layer from a model schema                  | **Adopt — and it corrects my own Part I prescription.** See §3.                                                                                                                                                                                                                                                                                                          |
| 6   | Fileside: onion layering (lib/system/app/infra/boot), features as domain/service/UI, "undoable commands through a central dispatcher"                                                                        | n/a pattern-wise; `Match` (42 exports) gives exhaustive tagged dispatch in v4                                                                                                                                       | **Adopt the dispatcher idea, decline the onion.** `DbWorkerContext.dispatch` is a 44-arm `switch` that throws `Error` in 7 places. A handler registry closed over `Match`/`Effect.catchTag` would make a new arm additive instead of an edit (OCP), which is exactly the pressure point as Sections are added. The onion layering would be a rewrite with no bug to fix. |
| 7   | "model long-lived resources (windows, child processes, DB handles) with scoped Layers so shutdown cleanup is automatic"                                                                                      | `Layer.effectDiscard` for background tasks, `Scope` + `acquireRelease` (5 uses today), `ManagedRuntime.disposeEffect` (`node-sqlite-client.ts:86`)                                                                  | **Adopt, and it is our biggest structural gap.** Our shutdown paths are hand-rolled in two places: `index.ts:535-550` (`before-quit` firing three best-effort teardowns) and `context.ts:833-852` (`close()` closing two scopes in a hand-written order). `Layer.launch` would express both as one scoped program.                                                       |

**Net of the seven sources: three adopt, two already-done, one decline for a
reason we had already decided, one decline as a rewrite.** The addendum's
central thesis — _"treat the main process as the composition root and build one
Layer graph there"_ — is correct, and it is precisely the one thing we have not
done.

---

## 2. What the addendum does not mention: modules that map onto our measured gaps

The addendum is v3-flavoured, so it names `Pool`, `RequestResolver`, `Cron` and
v3 service names. Reading `node_modules/effect/src` shows rc.115 ships a much
wider surface, including several modules that solve problems we are currently
solving by hand. All verified present in the installed package.

| Module                                                                                                                                                                              | The hand-rolled thing it replaces                                                                                                                            | Verdict                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`RcMap`**                                                                                                                                                                         | `agents/ledger-mcp/pool.ts`'s generation counter + `Deferred` flight identity, and `ipc.ts:64`'s `LedgerMcpAttachment { server, release }` refcount contract | **Adopt.** A reference-counted keyed map _is_ the per-conversation MCP attachment lifecycle. `get`/`getOption`/`keys`/`invalidate`/`touch`/`has` + `State.make`. **This corrects Part I's A5** — I proposed `LayerMap`, which builds layers keyed by identifier; `RcMap` is refcounted _values_, which is the actual semantic.   |
| **`Pool`** (+ `makeWithTTL`, `makeWithStrategy`, `use`, `reserve`, `invalidate`)                                                                                                    | the same sidecar pool, viewed as a reusable HTTP resource                                                                                                    | Adopt alongside `RcMap`; `Pool` for the health/TTL axis, `RcMap` for the per-conversation refcount axis.                                                                                                                                                                                                                         |
| **`SqlResolver`** (`request`, `ordered`, `grouped`, `findById`, batching)                                                                                                           | **all query-time aggregation in JS.** See §3.                                                                                                                | **Adopt, highest product value in this document.**                                                                                                                                                                                                                                                                               |
| **`SqlModel.makeRepository` / `makeResolvers`**, **`SqlSchema.findAll/findOne/findOneOption`**                                                                                      | the 21 hand-written members of `LedgerRepository` (`ledger-repository.ts:33-70`)                                                                             | Adopt — **but check before hand-splitting** (see §4).                                                                                                                                                                                                                                                                            |
| **`PartitionedSemaphore` / `Semaphore`**                                                                                                                                            | nothing — the 27k-line parser/scan has **no bounded fan-out**. `Effect.all({concurrency})` appears only in `snapshot.ts`                                     | Adopt. Per-provider permits bound a scan against a pathological session directory. A resilience win with no downside.                                                                                                                                                                                                            |
| **`SubscriptionRef`** (26 exports), **`ScopedRef`**, **`Latch`**                                                                                                                    | `agents/ipc.ts:154-158`'s `probedChain` + `probedQueued` "coalesce, latest-wins" probe queue                                                                 | Adopt. `SubscriptionRef` is a subscribable value with change notification — the probe slot _is_ that.                                                                                                                                                                                                                            |
| **`ScopedCache`** (15 combinators incl. `getSuccess`, `refresh`, `invalidateWhen`)                                                                                                  | `updates.ts`'s hand-rolled `Ref` + `Deferred` single-flight                                                                                                  | Adopt once slice 1 lands; `ScopedCache.getSuccess` is the memoize-in-a-scope primitive.                                                                                                                                                                                                                                          |
| **`FiberSet`**                                                                                                                                                                      | the `backgroundFxTasks: Set<Promise>` that W1 folded into a scope                                                                                            | Adopt only if background jobs multiply past the one cadence fiber. Low priority.                                                                                                                                                                                                                                                 |
| **`Metric`** (43 exports), **`Tracer`/`Span`/`MinimumTraceLevel`** (19)                                                                                                             | Part I's F14 (inert observability)                                                                                                                           | **Changes the shape of the A7 decision.** A span sink over pino is now a ~30-line local `Tracer`, and §5.4's "no exporter" is still honoured by not installing `unstable/observability/Otlp*`. The decision stops being "spans on or off" and becomes "which sink".                                                              |
| **`Match`** (42 exports)                                                                                                                                                            | the 44-arm `dispatch` switch                                                                                                                                 | Adopt. A missing arm becomes a compile error instead of a `throw` at `context.ts:828`.                                                                                                                                                                                                                                           |
| **`Path`**                                                                                                                                                                          | ~20 provider-home resolvers of hand-rolled `join`/`resolve`/`homedir` chains (the W9 rollout)                                                                | Evaluate. Low priority; the rollout's per-seam byte-fidelity discipline argues for leaving them.                                                                                                                                                                                                                                 |
| **`ErrorReporter`** (13)                                                                                                                                                            | the 19 `throw` sites in Effect files (F24)                                                                                                                   | Evaluate. Gives defects a structured channel instead of bare throws.                                                                                                                                                                                                                                                             |
| **`Graph`** (122 exports)                                                                                                                                                           | —                                                                                                                                                            | **Not a layer-graph introspector.** I checked hoping to measure our layer graph directly; it is a general immutable graph structure. Dropped.                                                                                                                                                                                    |
| **`unstable/rpc`** (`Rpc.make`, `RpcGroup`, `RpcServer`, `RpcClient`, `RpcWorker`, `Rpc.exitSchema`, `RpcTest`) + **`unstable/workers`** (`Worker`, `WorkerRunner`, `Transferable`) | our hand-rolled `postMessage` protocol (`db-worker/protocol.ts`, guards at `:90,:96`)                                                                        | **Real candidate, deferred.** Typed ops with Schema-validated payloads and typed failure/demorphism over the wire. But it replaces a _frozen_ protocol in the isolate that already carries the single-writer invariant, and `RpcTest` would genuinely improve the worker's test story. Do not do it in the same wave as slice 1. |
| **`unstable/cluster`**, **`unstable/workflow`**, **`unstable/persistence`**, **`unstable/ai`**                                                                                      | —                                                                                                                                                            | **Decline explicitly.** Single machine, local-first (ADR 0012), no network egress, no durable business process, no LLM call of our own. Recording the declines is what keeps the next evaluation from re-litigating them.                                                                                                        |

---

## 3. The finding that outranks every Effect question in this document

While verifying `SqlResolver` I checked what our query path actually does. It is
not an Effect problem. It is the largest performance and resilience liability in
the product, and it is invisible to every gate in the repo.

**Measured, statically, on this tree:**

1. `LedgerRepository`'s four bulk reads have **zero `WHERE` clauses and zero
   `LIMIT`s** (`ledger-repository.ts:111-153`).
2. `getCalls` selects **38 columns** per row, of which **six are JSON blobs**
   (37 until §3.1 caught the missing `call_key`):
   `tools_json`, `mcp_tools_json`, `skills_json`, `subagent_types_json`,
   `bash_commands_json`, `tool_sequence_json` (`:143-150`).
3. `getTurns` selects **`user_message`** — full prompt text — for every turn in
   the ledger, on every read (`:134`).
4. Each of the four is `z.array(<rowSchema>).parse(rows)` — so the **entire
   lifetime ledger is Zod-validated on every read** (`:119, :129, :138, :152`).
5. `buildSessionSummaries` (`store/aggregate.ts:493`) calls **all four** at
   `:107, :115, :116, :118, :520`.
6. `buildDashboardCoreFromLedger` (`views.ts:381-386`) calls
   `buildSessionSummaries` **and then `store.getSessions()` again at `:384`** — so
   one `store:views` request performs roughly **seven full-lifetime table reads**.
7. `buildSessionSummaries` is independently called by
   `buildAnalyticalViewsFromLedger` (`views.ts:85`), `views.ts:102`,
   `buildProjectRowsFromLedger` (`:143`), `:266`, `buildProjectsFromLedger`
   (`:278`), `buildDashboardCoreFromLedger` (`:382`) and
   `aggregate.ts:551` — i.e. **per Section channel**, each re-reading everything.
8. ADR 0002 mandates lifetime scans and `context.ts:90` hardcodes
   `lifetimeRange() = { start: new Date(0), end: new Date() }`, so the read volume
   **grows without bound** for exactly the users who care most.
9. There is no memoization anywhere on this path (`views.ts` and `aggregate.ts`
   build fresh `Map`s per call), and `DbWorkerClient`'s `DEDUPABLE_OPS` map
   (`client.ts:260-268`) only collapses _concurrent identical_ reads — it does not
   cache across requests.

So: every Section render is ~8 unbounded full-table reads, each Zod-parsed in
full, feeding 4,905 lines of view builders that aggregate in JavaScript over data
SQLite could have grouped.

**What I cannot claim without measuring:** actual latency or memory on a
populated ledger. I have no `ledger.db` with real data in this tree, so I am not
asserting a number. Slice 0 below exists to produce one.

**Why it belongs in an Effect evaluation:** the fix has two halves and both are
in-package in rc.115. Push the aggregation into SQL with `SqlResolver.grouped` /
`ordered` and `SqlSchema.findAll`; and put the surviving reads behind an
`RcMap`-or-`ScopedCache`-keyed `Effect<A, E, LedgerQueries>` so the reads per
request become one, scoped and interruptible. It is simultaneously the biggest
product win available, the strongest argument for the repository split (Part I
A3), and the first place the `WorkerLive` root (A2) pays for itself.

### 3.1 MEASURED — and partly refuted (slice 0, 2026-09-29)

`scripts/measure-query-path.cjs` (1,270 lines) builds a synthetic ledger through
the real `LedgerStore` + real `portIn` + real `SqlClient` + real `z.array(...).parse`,
with a `PRAGMA table_xinfo` guard that aborts on schema drift. Median of 5 runs,
one operation per `--expose-gc` child process, after an explicit `global.gc()`.
Machine: Windows 11, i7-12700H (14c/20t), 31.7 GiB, Node v24.13.0, NVMe.

| operation                       | 1,008 calls | 50,004 calls | 500,004 calls |
| ------------------------------- | ----------: | -----------: | ------------: |
| `read:getCalls`                 |     16.9 ms |     1,886 ms | **11,464 ms** |
| `read:getTurns`                 |      4.1 ms |     362.9 ms |  **7,249 ms** |
| `read:getSessions`              |      1.5 ms |      16.6 ms |        205 ms |
| `read:getSources`               |      1.1 ms |       9.9 ms |       70.9 ms |
| `buildSessionSummaries` (alone) |     67.8 ms |     1,967 ms | **20,085 ms** |
| **`store:views`**               |     55.4 ms |     2,299 ms | **19,258 ms** |
| **`store:analytics`**           |     92.5 ms |     4,863 ms | **38,226 ms** |
| **`overview:query`**            |    120.9 ms |     2,924 ms | **40,814 ms** |

Peak heap Δ at 500k: `overview:query` **6.12 GiB**, `store:analytics` 5.92 GiB,
`store:views` 2.79 GiB. Ledger on disk 1.0 / 42.2 / 423.7 MiB.

**Confirmed and quantified.**

- Zero `WHERE`/`LIMIT` — now machine-checked on every run, not a grep.
- `user_message` is **73.2%** of a `ledger_turn` row's bytes. The prompt text is
  the single largest item in the table.
- Zod validation is **47% of `getCalls`** at 500k (6,067 ms SQL-only → 11,464 ms
  parsed), 23% of `getTurns`, 28% of `getSessions`.
- No memoisation: `store:analytics` and `overview:query` are each exactly
  **2.0×** `buildSessionSummaries`; `store:views` is 8 repository round-trips.

**Refuted: the structured-clone claim.** The reads never cross the
`worker_threads` boundary — they run _inside_ the worker, and only the assembled
payload crosses. Measured clone bytes at 500k: `store:views` **22.4 KiB**,
`store:analytics` **1.5 KiB**, `overview:query` **38.9 KiB** — against the
456 MiB that `getCalls` materialises internally. The cost is worker CPU and
worker heap, not bytes on a wire. This also revises the `unstable/rpc`
evaluation: those payloads are 1–39 KiB, so a typed RPC layer is cheaper than
assumed, but the volume is not what made it interesting.

**Corrected: `getCalls` selects 38 columns, not 37** — this section said 37.
Now machine-checked, so it cannot drift silently again.

**Corrected: "seven reads" overstates the problem.** `getSources` + `getSessions`
are 0.28 s of a 19.3 s `store:views` — **1.4%**. `getCalls` + `getTurns` are
**97%** of the time. The finding is real but it is two reads, not seven.

**Corrected: the SQL-side-aggregation payoff is capped.** The five reads sum to
19.06 s and `buildSessionSummaries` measures 18.7–20.1 s, so
`queryScope` + reconstruct + `assembleSession` + identity attach cost **0–1 s,
under 6%**. In _memory_ the JS is not free (+0.6–1.8 GiB over `getCalls` alone),
but on time, `SqlResolver.grouped` buys at most ~6%.

**This re-specifies slice 5.** Ranked by measured share of the 19.3 s:

1. **Stop reading `user_message` in `getTurns`** — 73.2% of a turn row, and only
   the Skills/Optimize detectors plausibly want prompt text. Needs a narrower
   read shape, not a schema change.
2. **Stop validating the whole ledger on every read.** Zod is 47% of `getCalls`.
   `LedgerQueries` should return the aggregate a Section needs, not a
   fully-parsed lifetime table.
3. **Trim `getCalls`' column set** — 38 columns including six JSON blobs whose
   combined per-row cost is the largest in the table (`tools` 94.4 B,
   `mcpTools` 40 B, `toolSequence` 39.5 B).
4. **Memoise across the Sections** — the 2.0× multipliers are pure waste.
5. **Only then** consider `SqlResolver.grouped` for the remaining 6%.

Full method, per-size spreads (±13% at 500k, 1.8× run-to-run swing on
`read:getCalls` at 50k), the eight caveats, and the reproducibility table are in
[`docs/research/query-path-measurement.md`](./query-path-measurement.md).

---

## 4. Corrections to Part I

Stated plainly, because a second evaluation that quietly revises the first is
worth less than one that does not:

1. **A5 was wrong.** I proposed `LayerMap.Service` for the sidecar pool. `LayerMap`
   builds _layers_ keyed by identifier; the actual semantic is a refcounted
   _value_ per conversation. The right primitive is **`RcMap`** (+ `Pool` for the
   TTL/health axis). Corrected in §2 above and in the slice list below.
2. **F17's first row was wrong.** I claimed `DbWorkerClient`'s
   `Map<string, Promise>` read-dedup should become `Effect.cachedFunction`.
   **rc.115 has no `cachedFunction`** — `Cache` exposes only `make/get/set/has`.
   Worse, that dedup is _cross-process_ (in-flight worker requests), which a
   local Effect cache cannot model at all. The hand-rolled map is the right
   shape; what it lacks is a home in a composition root. Row downgraded from
   "replace" to "relocate".
3. **A3's prescription was premature.** Before hand-splitting `LedgerRepository`
   into three tags, check `SqlModel.makeRepository(Model, { tableName, spanPrefix,
idColumn })` — it may generate the repository from a model schema, in which
   case the split and half the Zod row schemas come from the declaration. Hand-
   splitting first would be the wrong order.
4. **A7 is no longer binary.** With `Tracer`/`Span` in-package, "spans on or off"
   becomes "which sink", and §5.4's no-exporter rule does not bind a local sink.

---

## 5. The synthesis

The seven sources, adjudicated, produce one sentence:

> **We solved the hard half of the Effect + Electron problem first — process
> topology, supervision with backoff, a frozen validated wire — and have not yet
> started the easy half: one layer graph per isolate.**

Everything in Part I's structural block and everything in §2 above is a
consequence of that one sentence. The main isolate composes three services, reads
one, and has one Effect call site (F13). The worker has no root at all (F10) and
four runtimes between two isolates (F11). Teardown is hand-written in two places
where `Layer.launch` would express it. The query path re-reads the entire ledger
seven times per request and aggregates in JS where `SqlResolver` would group in
SQL — and that path is the one a user actually feels.

**Revised order of value** (this supersedes Part I §6 where they differ):

1. **Slice 0 — measure the query path.** Populate a synthetic `ledger.db` at
   three sizes (1k / 50k / 500k calls) and time `store:views`, `overview:query`
   and `export:csv`. Nothing else in this list can be sized without it, and the
   §3 finding is currently an argument, not a number. Cost: a script and a
   document.
2. **Slices 1–4 (Part I) unchanged.** `WorkerLive`, retry policies, repository
   split (now gated on checking `SqlModel` first), ESLint `run*`/`throw` gates.
   These are the enablers and they are cheap.
3. **NEW Slice 5 — `LedgerQueries` + push aggregation into SQL.** After slices 0
   and 1, so the measurement is real and a root exists. `SqlResolver.grouped` /
   `ordered` for the six view aggregates; project/date/provider filters pushed
   into the `WHERE` clauses that do not currently exist; the seven reads per
   request collapse to one `LedgerQueries` read behind an `RcMap`/`ScopedCache`
   keyed by (scope, ledger version). **This is the slice that makes the product
   feel fast; the rest make the code clean.**
4. **`RcMap` for the MCP attachment + `Pool` for the sidecar** (corrected A5),
   `Stream` for the coach run, `tests/` into a tsconfig, `Predicate`, the
   `FileSystem` amendment, `it.effect`, Windows CI — unchanged in relative order.
5. **`unstable/rpc` for the worker protocol: deferred, not declined.** Evaluate
   it _after_ slice 5, when the payload volumes are known — a typed RPC layer is
   only worth its cost if it is typed over data that stays small.

---

## 6. Decisions this addendum adds

5. **The query path (§3): is SQL-side aggregation in scope for this issue, or a
   separate issue?** It is a bigger change than anything in Part I and it is not
   an Effect-adoption question — it is a data-layer question that Effect's SQL
   modules make cheap. My recommendation: a separate issue, opened now, with
   slices 0 and 5 in it, referenced from #148.
6. **`RcMap` or hand-rolled for the MCP attachment?** `RcMap` is the documented
   primitive and the refcount semantics are exactly right, but the current
   generation-counter code is tested and correct. If `RcMap` wins, it should win
   on a slice that also has a test proving no sidecar is left running after a
   crashed conversation — that property is what refcounting is for.
7. **Span sink (revised A7): pino, or no spans?** `Tracer`/`Span` are in-package;
   a pino sink is ~30 lines and honours §5.4. Or amend §5.4 to say spans stay off
   and stop naming `Effect.fn` spans that go nowhere.
8. **`unstable/rpc`: worth a spike?** One session to render a side-by-side of the
   current `postMessage` protocol against `Rpc` + `RpcWorker` for our op set,
   with a verdict. Cheap, and it retires a standing question.

---

## Appendix — verification commands

Everything asserted about rc.115 was read from `node_modules/effect/src`, not
from documentation:

```
src/                    # 130 top-level modules — RcMap, Pool, ScopedCache,
                        # PartitionedSemaphore, SubscriptionRef, Latch, FiberSet,
                        # Match, Path, ErrorReporter, Metric, Tracer, Graph,
                        # FileSystem, Cron, LayerMap, LayerRef
src/unstable/           # ai arbitrary cli cluster devtools encoding eventlog http
                        # httpapi net observability persistence process reactivity
                        # rpc schema socket sql workflow workers
src/unstable/sql/       # Migrator SqlClient SqlConnection SqlError SqlModel
                        # SqlResolver SqlSchema SqlStream Statement
src/unstable/rpc/       # Rpc RpcClient RpcGroup RpcMessage RpcMiddleware
                        # RpcSchema RpcSerialization RpcServer RpcTest RpcWorker
src/unstable/workers/   # Transferable Worker WorkerError WorkerRunner
src/StandardSchema.ts   # StandardSchemaV1 / StandardTypedV1 / StandardJSONSchemaV1
```

`Schema.ts:1339` exposes `toStandardSchemaV1`; grepping the whole of `src/` finds
no consumer and no `"~standard"` read outside the emitter — the basis for the
§1 row 2 verdict.
