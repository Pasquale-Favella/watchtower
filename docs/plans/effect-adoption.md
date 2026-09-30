# Effect adoption: second precise evaluation

> Plan only, no implementation. Measured 2026-09-29 against
> `146-ledger-schema-migrations` @ `aa81aa5`; companion to
> [`docs/research/effect-v4-electron.md`](../research/effect-v4-electron.md),
> which adjudicates the external Effect + Electron references against the
> `effect@4.0.0-rc.115` source. Live discussion: [#148](https://github.com/Pasquale-Favella/watchtower/issues/148).

Re-evaluation of #148's original assessment, measured against the tree as it stands
on branch `146-ledger-schema-migrations` at `aa81aa5` (`effect@4.0.0-rc.115`),
after Waves 1–10 plus 7 further commits (`aa81aa5`, `32b062d`, `def5ebe`,
`73c4de2`, `f3f1d4c`, `f732bac`, `e94c275`).

Method: every number below is a count or a `file:line` read from the tree, not an
estimate. Percentages are only used where the previous assessment used them, so
the two columns are comparable. Suite baseline re-measured: **88 test files,
1340 passed, 2 skipped, 41.5s**.

---

## 1. Verdict on the previous findings

### 1.1 The locked decisions (§5) — all four were executed as written

| Decision                                                                      | Status                                                                       | Evidence                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §5.1 removal order: gateway → `LedgerStore` per-slice → `DbWorkerClient` last | **Done, and the queue is now empty**                                         | `fetchVercelGatewayReport` deleted (W1); `LedgerStore.setDisplayCurrency` + `FxRates.layerWithStore` deleted (W9); `client.ts` `Promise.race + setTimeout` → `awaitGracefulShutdown` (W2). Zero compat adapters remain in the codebase.                           |
| §5.2 `Config` is env-only, persisted settings stay in the repository          | **Executed, then partially circumvented by a second mechanism**              | `src/main/env.ts` (418 lines) now carries BOTH an `Env` `Context.Service` (2 readable fields) and a module-scope `AppPaths` snapshot + `initAppPaths` + `appPaths()` (sync readers). See F21 — this is the one place the migration made the architecture _worse_. |
| §5.3 platform sequence `HttpClient` → `FileSystem` → `Command`                | **Steps 1 and 3 landed; step 2 still open and should now be closed as "no"** | `HttpFetch.layer` re-skinned on `effect/unstable/http` (W4); `CommandRunner` on `effect/unstable/process` (W9). Step 3 cost 438 lines of hand-written transport for one call site. Step 2's inputs are sync discovery reads — see A4.                             |
| §5.4 observability is a bridge over pino, no exporter                         | **Half-landed and inert**                                                    | `OperationalLogLoggerLayer` (`operational-log.ts:346`) is referenced only by `tests/operational-log.test.ts`. It is installed nowhere in production. See F14.                                                                                                     |

**The single most important conclusion of this re-evaluation:** the compat-adapter
programme is finished, and the work it was blocking was never started. Ten waves
retired every temporary bridge and composed two `Layer.mergeAll`s, and what
remains is not "adapters left to delete" — it is **composition roots that do not
exist**. Every remaining structural finding below is downstream of that.

### 1.2 The §1 scorecard, re-measured with the same method

| Slice                          | 2026-09-24   | 2026-09-29   | Δ   |
| ------------------------------ | ------------ | ------------ | --- |
| Ledger / db-worker             | ~65%         | ~72%         | +7  |
| Fetch / FX / pricing / updates | ~80%         | ~88%         | +8  |
| Scan orchestration             | ~45%         | ~48%         | +3  |
| Harness / agents               | ~30%         | ~42%         | +12 |
| Main runtime / IPC             | ~25%         | ~27%         | +2  |
| Renderer                       | 0% by design | 0% by design | —   |

The percentages hide the shape. The honest metric today is **Effect LOC share by
area**, and adoption is bimodal, not gradual:

| Area                        | Files with Effect | Effect LOC / total | %            |
| --------------------------- | ----------------- | ------------------ | ------------ |
| `db-worker/`                | 2 / 4             | 1151 / 1296        | **89%**      |
| `store/`                    | 4 / 6             | 944 / 1668         | 57%          |
| `agents/`                   | 8 / 44            | 2234 / 5094        | 44%          |
| `pipeline/`                 | 4 / 67            | 2237 / 27487       | **8%**       |
| the 11 `*-view.ts` builders | 0 / 11            | 0 / 4905           | 0% (correct) |
| **`src/main` total**        | **23 / 139**      | **7816 / 42753**   | **18%**      |

18% of the backend is Effect. The data-producing pipeline — `parser.ts` (4164
lines), `session-cache.ts` (749), and 62 provider modules totalling 27k lines —
is 8%. That is a defensible _outcome_ (pure parsing is the right place for plain
functions) but it means the previous assessment's remaining-slice framing
"migrate the providers" is the wrong target. The remaining effectful work is not
in the providers.

---

## 2. New findings the first assessment did not contain

F1–F9 are confirmations. F10–F24 are new.

### F10 — The db-worker has no composition root. (blocking, the enabler)

`src/main/db-worker/context.ts` provides layers **inside each call site**:

- `performScan` → `Effect.provide(Layer.mergeAll(liveFetchLayer(), Env.layer, OperationalLog.layer))` (`context.ts:226`)
- `startBackgroundFx` → `Effect.provide(work, liveFxLayer(this.ledger))` (`:247`)
- `currency:set` → `Effect.provide(FxRates.layerWithRepository(ledger))` (`:799`)
- `cadence:get` → `Effect.runPromise(Effect.sync(() => ledger.getRefreshCadence()))` (`:541`)

Consequences, all measurable: (a) `Env.layer`, `OperationalLog.layer` and
`HttpFetch.layer` are rebuilt on every scan; (b) nothing is a memoised singleton,
so "one runtime per isolate" is unenforced; (c) `dispatch` has ~44 arms of which
35 are plain synchronous calls and 4 wrap a single value in `Effect.runPromise` —
ceremony without composition; (d) **no arm can be tested with a substituted
layer**, because the layer is welded at the arm. Every one of the ~10 `Effect.run*`
calls in `context.ts` exists only because there is nowhere else to run.

### F11 — There are four Effect runtimes, not two.

`ManagedRuntime` exists at `main-runtime.ts:37` (main) and
`store/node-sqlite-client.ts:30` (one per `LedgerStore`). The worker's own
orchestration has none (F10). And `agents/ledger-mcp/entry.ts:32` instantiates a
third `LedgerStore` inside the MCP sidecar isolate. So: main runtime, worker
repository runtime, MCP-sidecar repository runtime, and no worker runtime at all.
`docs/architecture.md`'s "each isolate owns one application runtime" is not yet
true of any isolate.

### F12 — `LedgerRepository` is a 21-member god interface reached through a double sync round-trip.

`ledger-repository.ts:33` declares 21 methods spanning six concerns (ingest,
source lifecycle, model aliases, price overrides, currency, cadence, MCP startup,
skill dismissals, and four bulk reads). Every one of them is reached only through
a `LedgerStore` method that does
`runRepositorySync(repo => repo.getX())` (`ledger.ts:228-353`), which is
`this.runtime.runSync(...)` on a _second_ `ManagedRuntime`, on the same thread,
to obtain a plain value. The real cost: every ledger read is
`Effect → runSync → Effect → runSync → value`. No cancellation, no composition,
two runtimes, and an `SqlError` channel that is discarded at the boundary. This
is SRP and ISP violated, and it is the reason `LedgerStore` cannot be retired:
the facade is not a legacy shim, it is load-bearing.

### F13 — `HarnessProbe` has zero consumers, and main has exactly one Effect call site.

`MainLive = mergeAll(HttpFetch.layer, HarnessProbe.layer, Env.layer)`
(`main-runtime.ts:32-36`). Grep for `yield* HarnessProbe` across `src/main`:
**0 hits**. `mainRuntime` is called from `index.ts:342` and `:483` — both the
`updates:check` channel. So the main isolate composes three services, reads one,
and `architecture.md`'s "one composition root fronts the IPC surface" describes
intent, not state.

### F14 — The observability bridge is not connected.

- `OperationalLogLoggerLayer` (`operational-log.ts:346`): referenced only by
  `tests/operational-log.test.ts:405,422,441`. Installed in no production layer.
- `OperationalLogLogger` (`:314`) documents that **spans are intentionally
  ignored**. There are 67 `Effect.fn('…')` call sites (31 of them
  `LedgerRepository.*`). Every one of those spans is constructed and discarded.
- `Effect.log` has **0** call sites in `src/main`.
- `recordGauge` (`:250`) has 0 production call sites.
- The three counters that _are_ wired (`scan.duration`, `fetch.timeout`,
  `probe.outcome`) reach the sink through **optional value-seams** — `counters?`
  on `HttpFetch.layerWithFetch` (`fetch-utils.ts:287`) and
  `HarnessSnapshotCounters` (`snapshot.ts:25`) — not through the `R` channel. An
  omitted seam argument silently no-ops; an unmet `R` requirement is a type error.

§5.4 decided "bridge, no exporter". The bridge was built and never connected.

### F15 — No retry anywhere the user can feel it. (highest resilience value in this assessment)

`Effect.retry` appears once in `src/main`, and it is the sidecar READY poll
(`sidecar.ts:243`). `HttpFetch` deliberately has no retry, and the reasoning is
written down: _"callers already degrade to cached/snapshot fallbacks, and retries
would change that contract"_ (`fetch-utils.ts:233-234`, `:273-275`).

The contract was examined, not challenged. The consequence was not:

- `fx.ts`: a failed refresh leaves the last cached rate in place for
  `FX_CACHE_TTL_MS` = **24 hours** (`fx.ts:30`). Every currency figure in every
  Section is silently wrong for a day.
- pricing: falls back to the on-disk cache for its TTL.
- `updates:check`: returns "unable to check" for a single blip.
- vercel-gateway session discovery: `[]` plus a warn.

`respawnBackoffSchedule` (`client.ts:88`) already demonstrates the exact
primitive — `Schedule.exponential` + `Schedule.spaced` cap + `Schedule.jittered`
— for the one retry that _is_ policy-driven. Adding retry to the four fetch
call sites is ~15 lines total, guarded on `reason === 'network' | 'timeout'` so
aborts are never retried. This is the cheapest real resilience win available.

### F16 — `DbWorkerContext` is a 786-line god object.

It owns the scan lifecycle, the cadence scheduler, the FX job, settings + on-disk
sizing, export, ~44 dispatch arms, and the worker event emitter. Only three
methods are Effect-native (`performScan`, `scheduleCadenceEffect`,
`refreshFxOnCadence`); `dispatch` is a 350-line synchronous switch that throws
`Error` in 7 places (`:669, :684, :701, :716, :724, :791, :828`). A god object
whose own failure modes are unmodelled defects is the §3-S violation the original
assessment named, now at 2× the size it was then.

### F17 — Three hand-rolled concurrency primitives where Effect has built-ins.

| Site                             | Hand-rolled                                                        | Built-in                                                                     |
| -------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `db-worker/client.ts:260-268`    | `Map<string, Promise>` read-dedup                                  | keyed cache / `RequestResolver` / `Effect.cachedFunction`                    |
| `agents/ipc.ts:154-158, 214-241` | `probedChain` + `probedQueued` "latest wins, coalesce" probe queue | `Effect.cachedFunction` / `Semaphore` / a `Queue` drained by one fiber       |
| `ledger-mcp/pool.ts:60-101`      | generation counter + `Deferred` flight identity                    | `LayerMap.Service` (resources keyed by identifier — the documented use case) |

Each is correct and each is a place where cancellation, wake-up-on-completion
and fairness have to be re-derived by hand.

### F18 — The coach run seam is a raw `AsyncGenerator` with a hand-rolled cancel path.

`runtime.ts:383` (`async *run`), consumed by `for await` at `ipc.ts:376`,
cancelled via `gen.return()` at `ipc.ts:424`, with a
`Promise.race([allSettled, setTimeout(3000)])` reset barrier at `ipc.ts:451` and
an `AbortController` at `runtime.ts:475`. The `runtime.ts:486-494` comment
documents that the AI SDK's iterator is not async-iterable and must be driven
with explicit `next()` — i.e. a hand-rolled stream. `Stream.callback` into a
scope-owned `Queue` (the pattern `command-runner.ts` already uses successfully,
and the documented workaround for rc.115's uninterruptible
`Stream.fromAsyncIterable`) would replace the `AsyncGenerator` cast, the
`controller.abort()` + `iterator.return()` finalizer pair, and the 3-second
`Promise.race` with one construct that has cancellation built in.

### F19 — No `it.effect`. 113 `Effect.runPromise` calls in tests instead.

Measured across `tests/`: `it.effect` = 0, `it.scoped` = 0, `@effect/vitest` = 0,
`Effect.runPromise` = 113, `TestClock` = 72. Every effect test hand-rolls
`Effect.runPromise(x.pipe(Effect.provide(layer)))`. The suite therefore has no
shared vocabulary for the three assertions this codebase most needs pinned:
**fiber interruption, finalizer ordering, and layer-scope teardown** — which is
exactly what `it.effect` + `it.scoped` provide, and what `agents-effect-primitives.test.ts`
had to build by hand at 349 lines.

### F20 — `Predicate` is unused, against the repo's own mandated reading.

`docs/agents/effect.md` requires reading `node_modules/effect/AGENTS.md`, which
says: _"NEVER write your own helper functions like `isRecord` or `isString`"_.
Measured: 0 imports of `effect/Predicate`; **244** hand-rolled
`typeof x === '…'` guards in `src/main` (`parser.ts` alone has 41); **9** separate
copies of `function isRecord(value: unknown)` (`model-routing.ts:73`,
`runtime.ts:154`, `codewhale.ts:86`, `copilot.ts:542`, `open-design.ts:33`,
`opencode-family-sqlite.ts:328`, +3). Mechanical, zero risk, and it is the one
documented rule the repo has fully absorbed everywhere else.

### F21 — Two config mechanisms with different lifetimes, and one unreachable-by-test.

`Env` (a `Context.Service`, substitutable via `layerWithValues`) exposes two
fields. `AppPaths` (a module-scope mutable snapshot, `env.ts:346-378`) holds the
rest and is readable **only synchronously** — no Effect consumer can reach it and
no test can substitute it. The 18 `paths` parameters added in W9 are threaded to
exactly **one** production call site, and Wave 9's own comment says it is
"semantically identical to passing nothing". The reason is honest (sync discovery
predates any Effect context) but the destination is not reached: the snapshot is
_not_ the single source of truth, and a known gap is registered in the
checkable `REMAINING_DIRECT_ENV_READS` list. The 76 `process.env` sites in
`src/main` are now split across three mechanisms (Env service, AppPaths, direct
reads), which is worse for a reader than the 76 were.

Worse, W9 records a hard precondition it has not met: threading a real `paths`
record changes what a seam reads **without** invalidating cached parses, because
`session-cache.ts:165` fingerprints a second, unlinked inventory of the same
environment variables (`PROVIDER_ENV_VARS`). That is a correctness hazard, not
tidiness.

### F22 — `tests/` is in no tsconfig, so 88 test files have zero type coverage.

`tsconfig.node.json` includes `src/main`, `src/preload`, `src/shared`, `e2e`.
`tsconfig.web.json` covers the renderer. `tests/` is in neither. The known
`Effect.fail` arity error at `tests/agents-effect-primitives.test.ts:62` and the
real-clock race in the same file are both invisible to every gate in
`.github/workflows/test.yml`.

### F23 — No Windows CI runner, and the Windows code we just wrote is ungated.

CI runs `ubuntu-latest` only. Five Wave-9 tests are `skipIf(win32)`-guarded, so
no platform branch of the migrated seams is exercised anywhere. Meanwhile
`CONTEXT.md` rule 1 makes Windows a first-class packaging target (ADR 0015), and
the win32-specific code is exactly the risky kind: the `.cmd` shim
(`command-runner.ts`), `killProcessTreeSync` (`process-tree.ts`), `APPDATA` /
`USERPROFILE` platform roots (`ibm-bob.ts:22`, `open-design.ts:89`), the EPERM
workspace delete (`ipc.ts:171`), and the `x-apple`/`process.platform` arms.

### F24 — 24 `throw` sites live inside the 23 Effect-importing files.

`context.ts` 8 · `runtime.ts` 4 · `sidecar.ts` 4 · `node-sqlite-client.ts` 2 ·
`sqlite-migrations.ts` 2 · `probe.ts` 2 · `snapshot.ts` 1 · `scan.ts` 1. Plus ~63
`catch` blocks in the same files. The typed-failure discipline is real
(6 `Schema.TaggedError` types, `catchTag` where it matters) but the largest
Effect consumer is still the one with the most unmodelled defects, all of which
land in `Cause` as defects rather than typed failures.

> **Corrected 2026-09-29.** This finding originally said 19, with a per-file
> breakdown that summed to 20 — internally inconsistent. The count came from a
> line-anchored `^\s*throw ` grep, which structurally cannot see an inline
> `if (cond) throw new Error(…)` one-liner; four such sites exist
> (`probe.ts:77`, `sidecar.ts:58`, `sidecar.ts:61`, `sqlite-migrations.ts:31`).
> The correct figure is an AST count — `ThrowStatement` nodes in
> `src/main` files that value-import `effect` — which is **24**, now
> mechanised as a lint rule (see slice 4). Three of the 24 are deliberate
> re-throws of a caught value (`node-sqlite-client.ts:66`, `snapshot.ts:243`,
> `sidecar.ts:317`); they are flagged rather than carved out, because a
> `throw <identifier>` can equally be an unmodelled cached error.

---

## 3. Expanded adoption

Ranked by (user-visible resilience × structural cleanliness) ÷ cost. A1–A3 are
the enablers; A4 is a decision to _stop_ work; A5–A9 are the remainder.

### A1 — Retry policy per fetch (≈15 LOC, three lines per call site)

`Effect.retry(retryPolicy, { while: err => err.reason !== 'abort' })` on FX,
pricing, updates and gateway, where `retryPolicy` is
`Schedule.exponential(Duration.millis(500)).pipe(Schedule.compose(Schedule.recurs(2)))`.
Closes F15. The contract is not "callers degrade to fallbacks" — it is "callers
degrade to fallbacks **after** a bounded retry, so a 2-second network blip does
not cost 24 hours of wrong currency". The guard `reason !== 'abort'` keeps
interruption honest, which is the property the no-retry design was actually
protecting.

### A2 — One `ManagedRuntime` per isolate; `WorkerLive` as a flat layer (≈120 LOC)

```ts
// src/main/worker-runtime.ts  (new)
export const WorkerLive = Layer.mergeAll(
  OperationalLogLoggerLayer, // closes F14's dead bridge, 1 line
  Env.layer,
  OperationalLog.layer,
  HttpFetch.layer,
  FxRates.layerWithRepository(ledger),
  LedgerIngest.layer,
  LedgerConfig.layer,
  LedgerQueries.layer,
)
export const workerRuntime = ManagedRuntime.make(WorkerLive)
```

`context.ts` keeps its sync surface (it is a `worker_threads` message handler,
which is itself a legitimate composition root — ADR 0023) but every arm becomes
`workerRuntime.runPromise(armEffect)` and `performScan`/`refreshFxOnCadence`/
`pricing:refresh` stop providing their own layers. Closes F10, F11, F13, and
unblocks A3, P3 and P4. Acceptance: `Env.layer` constructed exactly once per
worker lifetime (assert with a counting fake); every dispatch arm substitutable
in a test without touching the arm.

### A3 — Split `LedgerRepository` (mechanical, 1–2 slices)

`LedgerIngest` (`portIn`, `deleteSource`, `clear`) · `LedgerConfig` (aliases,
prices, currency, cadence, MCP startup, dismissals — 14 members) ·
`LedgerQueries` (`getSources/Sessions/Turns/Calls`). Same implementation, three
tags, so the diff is a signature change. Closes F12, makes each independently
fakeable, and — the real prize — lets the view builders take `LedgerQueries`
through the `R` channel so `LedgerStore` loses its last callers and the facade
dies as a _consequence_ rather than as a queue item.

> **Decision 2026-09-30: hand-split, NOT `SqlModel.makeRepository`.** Checked
> before starting, as this section originally required.
> `SqlModel.makeRepository` is constrained to `S extends Model.Any` — a
> `Model.Class` declaration — and this repo has **zero**
> `Model.Class`/`Schema.Class`; it has 36 raw `sql.unsafe` template calls and 14
> hand-written Zod row schemas instead. Adopting it would mean authoring Model
> declarations and migrating every read and write off Zod, which
> `docs/architecture.md` locks as the single wire and contract truth. It is also
> the wrong shape: it generates single-table CRUD (`insert`/`update`/`findById`/
> `delete` plus `makeResolvers`), whereas the repository's centre of gravity is
> `portIn` — a multi-table transactional ingest a generated CRUD repository
> cannot express at all. The split stays a signature change over one
> hand-written implementation.

### A4 — Close platform step 2 (`FileSystem`) as "no", in writing

The `architecture.md` text already states the blocker honestly: rc.115 ships the
`FileSystem` service and `make` with **no platform implementation**, so adoption
means hand-writing a Node fs transport. Now weigh it against the actual inputs:
the ~20 remaining `node:fs` reads in `src/main` are _synchronous discovery_ reads
(`existsSync`, `readFileSync`, `statSync`) on provider paths that must resolve
before any Effect context can exist, plus the `.cmd`-resolution walk in
`which()`. A transport for those buys substitution that no test uses and
lifecycle that no resource needs. **Recommendation: record a permanent
`node:fs` exception for sync discovery, with the boundary rule** — sync discovery
stays plain functions; effectful, streamed, or retryable file work goes through a
port (`CommandRunner` is the existing example). This closes an item that has been
open for three waves instead of leaving it dangling, and it is the honest
counterpart to the two frictions W9 recorded on the child-process transport.

### A5 — `LayerMap.Service` for the sidecar pool and the harness snapshot store (2 slices)

Both are "resources keyed by an identifier" — the documented `LayerMap` use case
(`AGENTS.md` → _Dynamic resources with LayerMap_). Replaces `pool.ts`'s
generation + `Deferred` flight identity and `snapshot.ts`'s `storeScope` +
`probeHandle` pair, and gets keyed acquire/release/refcount semantics from the
library rather than from hand-derived generation counters. Closes half of F17.

### A6 — `Stream` for the coach run (1 slice)

`Stream.callback` into a scope-owned `Queue` (the pattern `command-runner.ts`
already uses) wrapping the SDK stream. Deletes the `AsyncGenerator` cast at
`runtime.ts:494`, the `AbortController` + `iterator.return()` finalizer pair, and
the `Promise.race` + `setTimeout(3000)` reset barrier at `ipc.ts:451` — replaced
by interruption plus a `Scope` drain. Closes F18.

### A7 — Decide spans, don't leave them dangling (1 line, or 1 slice)

Either install `OperationalLogLoggerLayer` in both runtimes so `Effect.log`
reaches pino (1 line, closes half of F14), or amend §5.4 to say "spans stay off"
and delete the `Effect.fn('…')` names that imply otherwise. The current state —
67 spans constructed and discarded, a Logger written and never installed — is
worse than either.

### A8 — `@effect/vitest` + `it.effect` (1 dependency, migrate 20 files opportunistically)

Not a rewrite: new effect tests use `it.effect`; existing ones migrate when
touched. The immediate win is a shared vocabulary for interruption and
finalizer-order assertions (F19), which the suite currently expresses by
re-implementing scaffolding in `agents-effect-primitives.test.ts`.

### A9 — `Predicate` (mechanical)

Replace the 9 `isRecord` copies and the hottest `typeof` guards. Zero risk,
satisfies the rule `docs/agents/effect.md` already mandates.

---

## 4. Expanded practice

Existing practice is sound and should be kept: `Effect.gen` + `Effect.fn`/
`fnUntraced` (67/19), all 7 services as `Context.Service` with a `watchtower/…`
identifier, typed failures via `Schema.TaggedError` + `catchTag`, spans outside
`either`, `run*` at roots, `TestClock` in tests. The deltas:

- **P1 — `run*` only at a composition root, as a lint rule.** `architecture.md`
  already states this rule; it is violated in ~25 places in `src/main`. Promote
  it to an ESLint `no-restricted-syntax` selector banning `Effect.run*` outside
  `main-runtime.ts`, `worker-runtime.ts`, `store/node-sqlite-client.ts` and
  `*CommandRunner`-style process entry points. Machine-checkable, zero product
  risk, and it makes F10's symptom class impossible to reintroduce.
- **P2 — no `Effect.provide` inside a workflow body.** Layers are composed at a
  root; a workflow that needs a service widens its `R`. This one rule would have
  prevented F10 entirely.
- **P3 — a counter or a log goes through the `R` channel, never an optional
  value-seam.** `counters?` on `layerWithFetch` and `HarnessSnapshotCounters`
  can be omitted, and omission is a silent no-op. `R = HttpFetch | OperationalLog`
  cannot be omitted.
- **P4 — `it.effect` for anything with a layer**; `TestClock` through
  `it.effect(TestClock)` rather than by hand.
- **P5 — no `throw` in a file that imports Effect.** 24 sites today (F24). A defect in
  a typed-failure codebase is a modelling bug; the linter can flag `throw` in
  files that import `effect`, same mechanism as P1.
- **P6 — `Predicate` for runtime type guards** (already mandated; unenforced).
- **P7 — `Effect.fn` names are a budget.** Keep `Service.method` for traced
  boundaries, `fnUntraced` for hot paths, and do not add a name to a function
  that is not a span worth having. If spans stay off (A7), say so in the code.

---

## 5. Clean architecture: the end state

```
main isolate      ManagedRuntime(MainLive)      ← IPC handlers (Promise + Zod façade)
                  MainLive = HttpFetch · HarnessProbe · Env · OperationalLogLoggerLayer

worker isolate    ManagedRuntime(WorkerLive)    ← dispatch arms
                  WorkerLive = OperationalLogLoggerLayer · Env · OperationalLog
                             · HttpFetch · FxRates(repository) · Ledger{Ingest,Config,Queries}
                  Scopes: scanScope (scan fiber) · backgroundScope (cadence + FX)

mcp sidecar       read-only LedgerQueries        ← no Effect runtime needed; sync reads only
```

Four moves, in dependency order:

1. **A2 `WorkerLive`** — the enabler. Nothing else can be composed without it.
2. **A3 repository split** — the double `runSync` round-trip disappears; the
   facade's last callers leave with it.
3. **F16 `DbWorkerContext` decomposition** — `ScanSupervisor` (fibers + cadence,
   already Effect-native) · `ViewQueries` (the ~44 sync arms, no Effect) ·
   `Dispatch` (an arm table). SRP without a rewrite, and it makes the
   `LedgerQueries` consumer (A3) a first-class collaborator rather than a static
   import of the god object.
4. **`LedgerStore` retirement** — not a queue item any more. It is the
   _consequence_ of (2) and (3).

Target-shaped, not aspirational: after (1)–(3), `src/main`'s Effect LOC share
should move from 18% to roughly 30%, with the 27k-line pure provider/parser
surface unchanged — which is the correct shape for this product.

---

## 6. Proposed slices

Ordered, each independently mergeable, each with an acceptance criterion that is
a test rather than a claim.

| #   | Slice                                                                  | Closes          | Acceptance                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `WorkerLive` composition root + `OperationalLogLoggerLayer` installed  | F10 F11 F13 F14 | `Env.layer` built once per worker lifetime (counting fake); every `Effect.provide` in `context.ts` gone; `it.effect` proof that a substituted layer reaches a dispatch arm |
| 2   | Retry policy on the four fetch call sites, abort-guarded               | F15             | TestClock test: a `network` failure retries twice then falls back; an `abort` failure retries zero times; the 24h stale-rate window is unchanged                           |
| 3   | `LedgerRepository` → `Ledger{Ingest,Config,Queries}`                   | F12             | three tags, one implementation; a test per slice with a fake; the double `runSync` round-trip removed from at least the config slice                                       |
| 4   | ESLint P1 + P5 (`run*` and `throw` in Effect files)                    | F10-class P1 P5 | the rules are in `eslint.config.mjs`, run over the tree, and the wave's own code is compliant                                                                              |
| 5   | `DbWorkerContext` split: `ScanSupervisor` + `ViewQueries` + `Dispatch` | F16             | three files, dispatch arm count unchanged, wire payloads byte-identical                                                                                                    |
| 6   | `LedgerQueries` behind the view builders; `LedgerStore` deleted        | F12 F16         | zero `LedgerStore` references repo-wide (grep-proven), one runtime in the worker                                                                                           |
| 7   | `Stream` for the coach run                                             | F18             | interruption + drain under `Scope`; the 3s `Promise.race` is gone; the `agents-effect-primitives` real-clock race is gone with it                                          |
| 8   | `LayerMap` for sidecar pool + snapshot store                           | F17             | generation counters deleted; a keyed release test                                                                                                                          |
| 9   | `tests/` into `tsconfig.node.json` + fix the surfaced errors           | F22             | `npm run typecheck` covers `tests/`; the `Effect.fail` arity error is fixed; CI goes red if it returns                                                                     |
| 10  | `Predicate` sweep                                                      | F20             | 9 `isRecord` copies → 1; `parser.ts` guards on the hot path converted                                                                                                      |
| 11  | A4 `FileSystem` amendment to §5.3 + `architecture.md`                  | §5.3            | decision recorded with the sync-discovery measurement as its evidence                                                                                                      |
| 12  | `@effect/vitest` (add) + `it.effect` for new effect tests              | F19             | one migrated file per slice; interruption/finalizer assertions expressed in `it.effect`                                                                                    |
| 13  | Windows CI runner (or a `vitest` project split)                        | F23             | the 5 `skipIf(win32)` arms execute somewhere                                                                                                                               |

Slices 1–4 are the high-value block and touch disjoint files. 5–6 are the same
area and should not run concurrently. 9, 10, 13 are independent of everything.

---

## 7. Decisions needed from the owner

0. **Schema consolidation (Zod → Effect Schema): HELD pending the `unstable/rpc`
   verdict — 2026-09-30.** The owner authorised replacing Zod outright, so the
   scope was measured rather than argued. Zod here is not a backend utility: it
   **is** the shared contract layer. 161 `z.*` definitions in `src`, **159** of
   them in `src/shared/schemas` (24 files); **51 of 123 renderer files** import
   it, across 18 renderer-facing modules (`renderer` 12, `models` 11, `overview`
   10, `agents` 7, …); 83 `.safeParse` and 214 `.parse` call sites in
   src+tests; only **4** `src/main` files import Zod directly. The renderer
   imports `effect` in **0** files today.

   The blocker is structural, not technical: `architecture.md` says the renderer
   consumes the "Zod-validated IPC facade" _and_ records "Renderer 0% by design"
   — the same decision stated twice. Converting `shared/schemas` to Effect
   Schema **is** putting Effect in the renderer, so the two rules move together.
   Nothing tests the 0% rule today, and `effect/Schema` is a pure synchronous
   validator rather than an orchestration runtime, so the honest amendment is
   "0% Effect _runtime_ in the renderer; `effect/Schema` permitted for wire
   validation" — ADR 0005's sandbox boundary is unaffected either way.

   **Why held rather than started:** Effect Schema is a _prerequisite_ for
   `Rpc` (which needs it for payloads) and for `SqlModel`/`SqlSchema`. Those are
   the only things that make a 159-schema migration pay for itself; without them
   the payoff is "one library instead of two" against a real risk, since
   `effect@4.0.0-rc.115` is a **release candidate** and this prerelease has
   already cost four gaps (no `fromStandardSchemaV1`, no `cachedFunction`, no
   platform `FileSystem` implementation, uninterruptible
   `Stream.fromAsyncIterable`). A Schema-module gap would take the whole app
   rather than one slice. **Fork:** if the rpc spike says adopt, migrate
   immediately - Wave A (the 4 main-only files + the row schemas in
   `shared/schemas/ledger.ts`; no renderer impact, one commit to revert) then
   Wave B (the 18 renderer-facing modules, after the ADR amendment), per
   contract and never both libraries for one. If it says decline, recommend
   Wave A only, or deferring entirely. Wave A also cannot start before the
   repository split lands - it is editing those exact row schemas.

> **RESOLVED 2026-09-30 - `unstable/rpc`: DECLINE.** See
> [`docs/research/effect-unstable-rpc-spike.md`](../research/effect-unstable-rpc-spike.md).
> The decisive finding is not a feature gap - it is that the Zod bridge works and
> is **completely type-blind**: a `Schema.declareConstructor` shim over
> `ZodAliases.safeParse` validates, round-trips, rejects malformed payloads and
> carries typed errors and streams through a real `RpcGroup` over `RpcTest` - and
> reports `Type`, `Encoded` and `~type.make.in` all `undefined`. `~type.make.in`
> is what the client method parameter is typed from (`RpcClient.ts:86`), so all
> **38** ops would be `unknown -> unknown`: today's `args: unknown[]` plus ~450
> lines and a per-contract adapter whose only job is the `safeParse` the arms
> already do at `context.ts:651`. `Rpc` is only worth having when it is typed,
> and typed is unavailable to it here. Separately, **0 of 9** `DbWorkerEvent`
> variants are expressible (`RpcClient` exports no notify/push/subscribe), the
> `ready`/`init-error` handshake has no home (`RpcServer.make` is
> `Effect<never, never, ...>` - a boot failure cannot be reported), the
> `inflightReads` dedup cannot cross a thread boundary, and `RpcClient`'s respawn
> is _worse_ than ours (unbounded `Effect.retry(Schedule.spaced(1000))` at
> `RpcClient.ts:1337` vs a capped, jittered, streak-resetting, TestClock-pinned
> schedule at `client.ts:80-100`).
>
> **Consequence: Wave B is declined.** Nothing downstream wants it, and it is the
> half that costs 51 renderer files and an ADR amendment. Zod stays the wire
> contract.
>
> **Wave A is recommended - but on entirely different grounds than "one library
> instead of two", which the verdict does not support.** The real argument is a
> defect the wave made visible: the six `z.array(<rowSchema>).parse(rows)` calls
> in `ledger-repository.ts` (`:130`, `:154`, `:165`, `:175`, `:184`, `:198`)
> **throw**. Inside `Effect.gen` a `ZodError` becomes an unmodelled **defect** in
> `Cause`, not a typed failure in `E` - so one corrupt row, a schema drift or a
> truncated JSON column takes a whole Section down with a defect the operational
> log has no code for, instead of a recoverable error the Section can degrade
> past. Effect Schema's `decodeUnknownEffect` puts the decode failure in the
> error channel, where `catchTag` and the allowlisted `OperationalLog` can handle
> it. That is the same typed-failure discipline P5 exists to enforce - and the
> new lint rule **cannot** catch these, because `no-restricted-syntax` matches
> `ThrowStatement` and a `.parse()` throw is not one. Banning `.parse()` inside a
> `src/main` Effect file is the follow-up that keeps the fix from regressing.
>
> Wave A's justification is therefore independent of `Rpc` and of `SqlModel`: it
> moves 6 call sites from the defect channel to the error channel, touches no
> renderer file, and needs no ADR change. Explicitly not a speed play - Effect
> Schema is not faster than Zod 4, and the 47%-of-`getCalls` decode cost is
> fixed by _reading less_, which is slice 5's job, not by changing libraries.

1. **§5.3 step 2 (`FileSystem`): close as "no"** with a permanent `node:fs`
   exception for sync discovery (A4), or fund the hand-written transport. The
   evidence points to closing it.
2. **Spans: on or off?** If on, A7 is a slice. If off, amend §5.4 and stop
   spending `Effect.fn` names on discarded spans.
3. **Windows CI:** add a `windows-latest` runner to `test.yml`, or accept that
   the win32 arms of the code we just migrated are ungated.
4. **`tests/` typecheck:** bring `tests/` under a tsconfig (surfacing 2+ known
   errors immediately) or keep it outside deliberately.

---

## Appendix — measurement notes

- LOC counted with `Measure-Object -Line` on raw file content.
- "Effect LOC" = LOC of files importing `effect` — an upper bound on Effect
  usage and the same method the per-slice table uses, so the two are comparable.
  It is not a claim that every line in those files is Effect.
- Service-consumer counts are `yield* <Service>` grep hits in `src/main`.
- `Effect.run*` count is 25 in `src/main` (11 `context.ts`, 10 `snapshot.ts`,
  6 `runtime.ts`, 3 `pool.ts`, 3 `sidecar.ts`, 2 `main/index.ts`, 1 each
  `auth-probe.ts`, `process-tree.ts`, `vercel-gateway.ts`, `client.ts`,
  `ledger-repository.ts` seam, `node-sqlite-client.ts`) — several files contribute
  to more than one group; the point is the total, not the partition.
- Suite baseline re-measured on this tree: 88 files, 1340 passed, 2 skipped
  (the two pre-existing `skipIf(win32)` arms), 41.5s.
