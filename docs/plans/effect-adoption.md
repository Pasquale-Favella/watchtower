# Effect adoption: second precise evaluation

> **Current assessment, 2026-09-30:** use [the updated assessment](../research/effect-adoption-assessment-2026-09-30.md)
> and [section 6](#6-current-execution-order) for status and execution order.
> They start from issue #148's penultimate comment and incorporate the latest
> comment and commits through `a917305`. The September 29 findings below are
> historical evidence; their counts, open decisions, and completion claims are
> not the current schedule. Query and ledger Schema edits in the working tree
> are still in flight. Later owner decisions authorize Schema in the renderer,
> replace pino with the Effect logging API and local writer, decline RPC and
> SqlModel, and leave Windows CI recorded but unscheduled.

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

### F12 — `LedgerRepository` is a 23-member god interface reached through a double sync round-trip.

`ledger-repository.ts:33` declares **23** methods spanning six concerns (ingest,
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

> **RESOLVED — split landed as three ports.** The split is
> `LedgerIngest` (3: `portIn`, `deleteSource`, `clear`) · `LedgerQueries`
> (4: the bulk reads) · `LedgerConfig` (**16**, not the 14 first estimated). One
> private `LedgerImplementation` service is projected into all three, and a
> normalised line-by-line diff of the 454-line `Effect.gen` body reports exactly
> one difference — the tag name — so every `sql.unsafe` and every
> `z.array(...).parse` is byte-identical. The 23-member count and the 16-member
> config concern are what the tree actually declared; the original 21/14 was
> miscounted. `LedgerStore` and the double round-trip survive by design, with
> named conditions recorded: the facade dies when the 11 view builders take
> `LedgerQueries` through the worker's `R`, which is slice 7.

### F13 — `HarnessProbe` has zero consumers, and main has exactly one Effect call site.

`MainLive = mergeAll(HttpFetch.layer, HarnessProbe.layer, Env.layer)`
(`main-runtime.ts:32-36`). Grep for `yield* HarnessProbe` across `src/main`:
**0 hits**. `mainRuntime` is called from `index.ts:342` and `:483` — both the
`updates:check` channel. So the main isolate composes three services, reads one,
and `architecture.md`'s "one composition root fronts the IPC surface" describes
intent, not state.

### F14 — The observability bridge is not connected.

> **HALF-CLOSED 2026-09-30.** The **Logger** half is done: `OperationalLogLoggerLayer`
> is now installed in `WorkerLive` (`worker-runtime.ts:101`), so `Effect.log` reaches
> the main-owned pino sink. `Effect.log` still has 0 call sites, which is a separate
> (unused-API) question, not a broken-bridge one. The **Tracer** half is untouched
> and is slice A7 below.

- `OperationalLogLoggerLayer` (`operational-log.ts:346`): referenced only by
  `tests/operational-log.test.ts:405,422,441`. Installed in no production layer.
- `OperationalLogLogger` (`:314`) documents that **spans are intentionally
  ignored**. There are **35** `Effect.fn('…')` call sites, **all in `src/main`**
  (the renderer is 0% Effect by design, per ADR 0032). Every one of those spans is
  constructed and discarded.
  - _Correction:_ this finding originally said **67** sites, 31 of them
    `LedgerRepository.*`. Re-counted against the tree on 2026-09-30 it is **35**.
    I cannot reconstruct what the 67 counted — most likely `Effect.fnUntraced`
    and the `LedgerRepository.*` method names folded together. The number that
    matters for A7's sizing is 35.
- `Effect.log` has **0** call sites in `src/main`.
- `recordGauge` (`:250`) has 0 production call sites.
- The three counters that _are_ wired (`scan.duration`, `fetch.timeout`,
  `probe.outcome`) reach the sink through **optional value-seams** — `counters?`
  on `HttpFetch.layerWithFetch` (`fetch-utils.ts:287`) and
  `HarnessSnapshotCounters` (`snapshot.ts:25`) — not through the `R` channel. An
  omitted seam argument silently no-ops; an unmet `R` requirement is a type error.

§5.4 decided "bridge, no exporter". The bridge was built; the logger end is now
connected, the tracer end is not.

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

### F25 — An unbounded retention leak in the coach run registry, found while measuring F17.

> **Correction, 2026-09-30:** FinalizationRegistry cannot reclaim a generator
> strongly retained by activeRuns. A timeout on return() does not stop pending
> work. The fix needs an independently callable stop handle and bounded cleanup.
> See F30 in [the current assessment](../research/effect-adoption-assessment-2026-09-30.md#f30-f25-needs-cancellation-that-can-run-while-event-pulling-is-stuck).

`ipc.ts` keeps `activeRuns` and `cancelledRuns` as module-closure maps. A run is
removed from `activeRuns` at the end of the stream pump's `finally` — the only
place — so a run whose generator never settles (a wedged ACP child; an
interruption that never reaches the `finally`) is **retained forever**. Its entry
holds the request, the run id, and the live generator.

`reset()` and `dispose()` both drain attachments now (`67c1e79`) and both wait
on a 3s teardown barrier, so the _conversation_ cannot strand a claim. What they
cannot do is reach a `finally` that a wedged child will never enter. The
app-scoped sidecar keeps serving, so nothing user-visible is stranded, but the
map grows without bound for the app's lifetime and each entry is a live
generator.

Separate from, and adjacent to, the attachment contract just hardened — same
file, same failure mode, different map. It was out of the measuring slice's
scope and is recorded here rather than folded in. **This is a correctness bug, not
a migration opportunity:** the original proposal was a `FinalizationRegistry` or an
explicit per-run timeout, neither of which is an Effect adoption.

### F26 — TestClock tests burn the full timeout instead of failing, so contention is indistinguishable from a regression.

Found 2026-09-30 by wrongly suspecting slice A7. Recorded because the
false accusation is the useful part: I ran a full suite, saw one timeout, saw
A7's tracer in the same tree, and stated that A7 was implicated. Re-running
with A7 present: **green, 38.5s**. Re-running with A7 reverted: **green,
37.6s**. The 0.9s delta is noise. The first run's 139.8s and single failure were
machine contention, and I had no reproduction before making the claim.

**The real defect is the shape of the failure.** `vercel-gateway-effect.test.ts`

> "timeout via TestClock returns []" forks a fiber, advances a `TestClock` by
> `worstCaseRetryWindowMs(8_000)`, and joins. Its own comment records the hazard:
> _"A window sized for one attempt parks the fiber on a virtual sleep, so the test
> hangs to the 120s timeout instead of failing on its assertion."_ Under CPU
> contention the fiber is not scheduled, the virtual window is not consumed in
> time, and the test **hangs for the full 120s rather than failing**. The same
> symptom appeared in `tests/yield-view.test.ts` (which builds and shells out to
> its own temp git repos) during the same window. Two unrelated files, one
> mechanism, no shared cause.

So a loaded machine produces a 120s stall and a red suite, and the red is
indistinguishable from a real failure. That is the worst possible property for a
gate, and it is a direct consequence of F19: with 113 `Effect.runPromise` calls
and no `it.effect`, virtual-time tests are hand-rolled, and a hand-rolled
virtual-time test fails by hanging.

**Not fixed here** — it is not A7's, and the fix (A8's `it.effect`, or bounding
these two tests with a `describe`-level timeout well under the global 120s so a
hang reads as a fast failure) deserves its own slice rather than a drive-by in a
tracer commit. Recorded so the next person who sees a 120s stall knows to
reproduce before believing it.

### A10 — Effect is the logging API; pino is the transport (owner decision 2026-09-30) — NEW

The owner asked to embrace Effect logging fully. Taken literally that means
adopting Effect's observability modules, and **every one of them is a network
exporter** — in rc.115 `effect/unstable/observability` ships `Otlp`,
`OtlpExporter`, `OtlpLogger`, `OtlpMetrics`, `OtpResource`, `OtpSerialization`,
`OtpTracer`, `PrometheusMetrics`, and **no file sink at all**. ADR 0012 is
explicit that the app adds no network path of its own, so adopting them means
amending a privacy ADR. That is the owner's call and it was put to them.

**Decided: Effect is the API, pino is the transport.** No domain code touches
pino; `Logger.make` / `Tracer.make` are the only surfaces, and one JSON-lines
file under `userData/logs` remains the destination. ADR 0029 is untouched, the
passing `e2e/operational-log.spec.ts` keeps passing, and no telemetry leaves the
machine. Adopting an OTLP exporter later is a one-transport swap — which is the
point of having the API Effect-shaped now.

**What is left is the call sites, and the split is not even.** Measured across
all 40:

|                                              | sites  | disposition                                                             |
| -------------------------------------------- | ------ | ----------------------------------------------------------------------- |
| implementation (`operational-log.ts` itself) | 8      | the sink; stays                                                         |
| **in files that already import Effect**      | **19** | become `Effect.log*` / spans                                            |
| composition seams (`index.ts` 8, `ipc.ts` 5) | 13     | **stay** — no runtime, and they are the boundary ADR 0032 already names |

The 13 are not a compromise. `index.ts` and `ipc.ts` are the `Promise`-shaped
edges where external callbacks enter and leave Effect; a bare logger call there
is the correct shape, and forcing `Effect.runSync` to reach one would be exactly
the F10 violation this programme exists to remove.

_Count correction:_ I first said 27 migratable sites. That double-counted the
sink's own 8. It is **19**.

**The load-bearing reason this is not a no-op:** `Effect.log` has **0** call
sites in `src/main`, so the `OperationalLogLoggerLayer` installed at
`worker-runtime.ts:101` currently forwards nothing at all. Nineteen sites is the
whole distance between "the logger is installed" and "the logger is used".

### A11 — Effect Schema in the renderer, to close the Zod drop (owner decision 2026-09-30) — NEW

The owner authorised Effect in the renderer **if needed to drop Zod**. It is
needed, and the cost is far lower than "adopting Effect in the renderer" sounds,
because the two are separable:

- **`effect/Schema` is pure and synchronous.** Verified by direct probe against
  rc.115, with no `Effect` import, no runtime and no fiber: `decodeUnknownSync`
  validates, `Schema.Literals([...])` accepts every member, and
  `.pipe(Schema.check(Schema.isFinite()))` rejects `NaN` where bare
  `Schema.Number` accepts it — R1 and R2 confirmed live a second time.
- So the renderer can take `effect/Schema` **in place of Zod** at the ADR 0005
  tripwire and change nothing else: still Promise/React-shaped, no
  `ManagedRuntime`, no layers, no fiber cancellation across the React tree.

**The renderer therefore still has 0% Effect _runtime_.** What changes is its
validation library. ADR 0032 needs amending to say that precisely — and the
amendment is small, because the architecture is not moving.

**Known migration cost, not yet sized:** Zod's `.parse` throws `ZodError`;
Effect's throws with a `cause` of `SchemaError`. There are **214** `.parse`
sites and **83** `.safeParse` sites tree-wide, and any code catching `ZodError`
by name has to change. Grep for `ZodError` before estimating this as mechanical.

**Sequencing:** Wave A (the 5 main-only modules) needs neither this nor an ADR
amendment, and is blocked only on slice 5a. Wave B's 19 renderer-facing modules
are last, and only because of the renderer work above.

> **UPDATED 2026-09-30, later the same day. Rate: ~2 failures in 7 full-suite
> runs, and I blamed the wrong slice TWICE.** The first was A7 (above). The
> second was A12, the pino removal, and the way I got there is the part worth
> keeping. Two consecutive runs came back at 124.3s and 126.1s, each with one
> TestClock file timing out and each a _different_ file
> (`pricing-effect`, then `fx-effect`). I then reverted A12's twenty files,
> ran the control, got **36.78s green**, and wrote "A12 IS the cause — this time
> I have the control I lacked for the A7 accusation." The very next run, with
> A12 restored, was **31.03s green**. One control run is not a control; it is a
> sample, and I treated it as proof in the same breath as I had denied myself
> the evidence the first time. The `writeSync`-per-record hot path I had already
> been told about was a real thing to check and I checked it only after
> declaring victory.
>
> What is actually established: the flake is **pre-existing**. Slice 5a's agent
> saw it in `fx-effect.test.ts` before A12 existed, and the rate spans pre-A12 and
> post-A12 trees alike. It is not a property of any slice.
>
> **NARROWED the same evening. Four hypotheses tested, three falsified.** I could
> not make it reproduce in isolation, which is the useful result:
>
> - **Falsified — A12's `writeSync`-per-record hot path.** The suite ran green at
>   31.0s with A12 in place.
> - **Falsified — the fork/adjust race.** A standalone repro of the documented
>   pattern (`forkChild` → `TestClock.adjust` → `Fiber.join`), 40 iterations on a
>   box loaded with 12 spinners, never stalled. Adding `Effect.yieldNow` first
>   changed nothing.
> - **Falsified — "one `adjust` cannot drive a multi-step retry".** A modelled
>   3-attempt retry with two 1s backoffs fired _both_ sleeps off a single
>   `adjust(5s)`, timestamps 1s apart. 0/30 stalls.
> - **Falsified — a real-time dependency inside the test.** `fx-effect`'s flaky
>   case calls `makeStore()`, which opens a real SQLite database, so real I/O
>   _is_ on the path — and still cannot hang.
>
> **What survives:** it does not reproduce outside a whole-suite run. 24 runs of
> the three files that flaked, on a deliberately loaded box, with `testTimeout`
> lowered to 15s so a stall would surface in seconds — **all green**. Vitest sets
> only `testTimeout: 120_000`; pool and `isolate` are defaults, and
> `isolate: true` rules out a cross-file singleton leak. The surviving
> explanation is **whole-suite oversubscription**: 99 files across a fork pool on
> 20 logical CPUs, summed `collect` reaching 215s, starving a worker until a
> fiber parked on virtual time never resumes. That also explains why "the machine
> is idle" kept reading clean — no competing _processes_, while the suite itself
> saturates the CPU.
>
> **Two mitigations, neither applied, because each trades something the owner
> should weigh.** (1) Bound the ten fork+adjust files — `agents-effect-primitives`,
> `command-runner`, `db-worker`, `fetch-retry`, `fx-effect`, `http-fetch`,
> `ledger-mcp-pool`, `pricing-effect`, `updates-effect`, `vercel-gateway-effect` —
> with a per-file timeout far below 120s, so a stall reads as a fast obvious
> failure. Buys diagnosability. (2) Cap the pool's worker count to stop
> oversubscribing. Buys reliability at some wall-clock cost. **Diagnosability
> first**: until (1) exists, a future occurrence costs 2 minutes and still tells
> us nothing.

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

> **OWNER DECISION 2026-09-30: log it, do not schedule it.** No Windows runner
> added to CI. The finding stands and the case below is unchanged; it is simply
> not worth per-push runner minutes until a Windows-only failure has actually cost
> time. Revisit if that changes — the evidence for it is real, not speculative.

CI runs `ubuntu-latest` only. Five Wave-9 tests are `skipIf(win32)`-guarded, so
no platform branch of the migrated seams is exercised anywhere. Meanwhile
`CONTEXT.md` rule 1 makes Windows a first-class packaging target (ADR 0015), and
the win32-specific code is exactly the risky kind: the `.cmd` shim
(`command-runner.ts`), `killProcessTreeSync` (`process-tree.ts`), `APPDATA` /
`USERPROFILE` platform roots (`ibm-bob.ts:22`, `open-design.ts:89`), the EPERM
workspace delete (`ipc.ts:171`), and the `x-apple`/`process.platform` arms.

> **Corroborated 2026-09-30, accidentally.** While integrating slice 8, a single
> locked `%TEMP%\watchtower-coach-*` directory — left by a crashed test run, held
> by a process nobody could identify — took **53 tests** in `tests/agents-ipc.test.ts`
> red, on the assertion that no coach temp dirs remain. Every one of those tests
> passed on a machine where nothing happened to be holding a handle. The fix was
> to scope the assertion to the directory the test itself created (`67c1e79`),
> which is the right fix regardless — but the failure mode is precisely F23:
> **this is a Windows-only, timing-dependent, handle-holding failure that CI on
> Linux cannot reproduce and that only surfaced by accident on a dev machine.**

**What this decision does NOT say:** that the Windows-specific code is fine. It
says the gate for it is a developer's machine, which is where slice 8's failure
was found and where it will be found again.

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
prices, currency, cadence, MCP startup, dismissals - 16 members) ·
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

### A5 — ~~`LayerMap.Service` for the sidecar pool and the harness snapshot store~~ — **the pool half REJECTED after measurement; the snapshot half stands**

I got this one wrong three times, in a way worth recording because the pattern
is the lesson. `LayerMap.Service` → `RcMap` → rejected, all three in one
afternoon. Each time I picked the primitive from the _shape of the words_ — "keyed
resource", "reference counting" — without checking whether the thing being
counted has a lifetime that can end. The sidecar pool's does not.

The `RcMap` rewrite was written in full, measured, and reverted. Three reasons,
in `pool.ts`'s header where the next reader will hit them:

1. **`RcMap.get` runs its lookup in a FORKED FIBER**
   (`Effect.runForkWith(...).pipe(Fiber.runIn(entry.scope))`), so `deps.spawn`
   runs a scheduler turn _after_ `acquire`'s synchronous frame. That frame is
   load-bearing: two existing tests pin that two same-tick acquires provably
   share ONE boot, and that a `releaseAll` in that same tick orphans a boot that
   _was_ adopted (so the orphan is released, never pooled). Both go red. Making
   the boot eager to restore it means keeping a flight marker to coalesce it —
   i.e. keeping the machinery `RcMap` was meant to replace, one level up.
2. **The refcount is CONSTANT.** ADR 0027 makes the sidecar app-scoped with an
   implicit permanent claim, so the count is `1 + live runs` and never reaches
   zero — which is the only state `RcMap`'s release-at-the-last-reference ever
   acts on. An infinite `idleTimeToLive` would then be load-bearing, and
   `invalidate` (the one teardown that respects outstanding references) could
   never be the health gate.
3. **Killing an unhealthy sidecar must be immediate, not deferred to the last
   holder.** It is already dead (health gate) or its token is already invalid
   (ADR 0027's regenerate deliberately disconnects existing clients).

**What the attempt did produce, and is kept** (`67c1e79`): a genuine bug fix — a
failed boot no longer poisons the pool for the app's life — and a hardened
per-run attachment contract, so a conversation's teardown releases what its runs
hold and a wedged generator cannot retain a claim past it. Both RED-verified
against pre-slice. Neither needs `RcMap`; both are the kind of defect the
`Deferred` flight machinery was hiding, which is an argument for the hand-rolled
code being _read_, not replaced.

**`snapshot.ts` is untouched and the half-claim on F17 stands.** Its
`storeScope` + `probeHandle` pair is a real scoped resource with a real end,
which is exactly the distinction the pool half failed.

**Standing rule, added because I broke it twice:** before prescribing a
concurrency primitive from Effect, establish that the resource's lifetime can
actually end. "Reference counting" is only a problem if references reach zero.
`activeRuns`/`cancelledRuns` in `ipc.ts` is where that question is still open
and unanswered — see F25.

### A6 — `Stream` for the coach run (1 slice)

`Stream.callback` into a scope-owned `Queue` (the pattern `command-runner.ts`
already uses) wrapping the SDK stream. Deletes the `AsyncGenerator` cast at
`runtime.ts:494`, the `AbortController` + `iterator.return()` finalizer pair, and
the `Promise.race` + `setTimeout(3000)` reset barrier at `ipc.ts:451` — replaced
by interruption plus a `Scope` drain. Closes F18.

### A7 — Pino `Tracer` for the 35 dangling spans (1 slice) — **owner decision 2026-09-30: BUILD**

The Logger half landed with Wave 1 (`OperationalLogLoggerLayer` installed at
`worker-runtime.ts:101`). The **Tracer** half is untouched, so the 35
`Effect.fn('…')` spans in `src/main` are still constructed and discarded.

Two options were on the table. The owner chose to **build the ~30-line pino
`Tracer`**, declining the alternative of amending §5.4 to say spans stay off.
The deciding argument is that §5.4 already promises observability and the app does
not deliver it; amending the doc makes the promise match the code, but 35 named
spans are the most direct read on where time actually goes in the query and
ingest paths — and slice 5a's whole thesis is that those paths are too slow.

**Shape.** `Tracer.make({ span })` returning a `NativeSpan` subclass that
overrides `end()` to emit one pino record through the existing allowlisted seam
(`safeLogOperationalEvent`), plus a `TracerLayer` installed in `WorkerLive` beside
the logger. A span **end** is the only write — a start-per-span log line doubles
the file volume for no diagnostic gain, and duration is what the record carries.
Attributes and events ride along on the end record; no span is ever sampled
in-band.

**Constraints.**

- **Never throws**, including before `initOperationalLog` and including inside a
  fiber finalizer. `OperationalLogLogger` is the shape to copy (`:314`), and the
  `OperationalLog` class's own `if (!active) return` mirror.
- **Records go through `sanitizeOperationalRecord`**, so only allowlisted keys
  survive. Span attributes are Effect-internal (fiber annotations, log
  annotations) and are not vetted ledger facts — same contract as `Effect.log`
  call sites: never log prompts, paths, or ledger facts.
- **`Exit` must not be stringified wholesale.** A failed span's exit carries the
  error channel; render `errorCodeFor(Cause.squash(...))` into `code` exactly as
  the Logger does, never the message.
- `MainLive` gets the layer too, or A7 leaves the main isolate's spans dangling
  and merely relocates the problem.

**Sizing correction:** F14 said 67 span sites. It is **35**, all in `src/main` —
the renderer is 0% Effect by design, so there is no second population to count.

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

> **Superseded by the current assessment:** view loading has IO and should be an
> Effect workflow; calculation accepts explicit data. The MCP isolate still needs
> its own scoped read-only SQLite runtime. Repository tag splitting did not
> remove the worker's nested runtime. Use F27 and F29 for the revised design.

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

## 6. Current execution order

The expanded [target architecture](./effect-target-architecture.md) makes full
Schema replacement, dependency direction, request reuse and refresh freshness
explicit completion criteria. ADR 0034 now records the authorized Schema target;
ADRs 0003, 0005 and 0032 are amended. Further findings F33-F37 extend the assessment, including the SDK registration dependency.

This schedule supersedes the original table and the penultimate issue comment's
queue. Finding identifiers remain stable. Numbers 6 and 7 below use that issue
comment's order, where the context split precedes facade retirement. The source
assessment and rationale are in [the September 30 assessment](../research/effect-adoption-assessment-2026-09-30.md).

The implementation baseline is local commit `ce81593`, which includes the
ledger Schema conversion after the call projection in `b7f47e7`. Current wave
ownership and verification are recorded in the target architecture's execution
record. Coordinate shared ledger files between sequential slices. Historical
gate results in issue comments do not verify the current working tree.

### Completed or decided

| Item                 | Disposition                                                                            |
| -------------------- | -------------------------------------------------------------------------------------- |
| 0, query measurement | Historical baseline complete; rerun after query changes before claiming an improvement |
| 1, WorkerLive        | Root implemented; F27 connection ownership and F28 forwarding remain                   |
| 2, transient retry   | Implemented on four fetch callers with abort guard                                     |
| 3, repository split  | Three ports implemented; nested runtime and facade remain                              |
| 4, lint              | Composition and throw rules implemented, warn-only                                     |
| 8, sidecar pool      | RcMap/Pool replacement declined; attachment hardening implemented                      |
| 12, FileSystem       | Sync discovery remains a documented Node exception                                     |
| A7/A10               | Tracer and Effect logging implemented; pino removed; forwarding remains                |
| SqlModel/RPC         | Declined under recorded decisions; not prerequisites for Schema                        |
| 14, Windows CI       | Finding retained, intentionally unscheduled                                            |

### Work to execute

| Order               | Work                                                                                       | Depends on                                                                     | Acceptance                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First, independent  | F26 mitigation and Effect test support                                                     | None                                                                           | A parked virtual-time test fails under a bounded real-time ceiling; scheduler and retry assumptions are explicit. Verify rc.115 compatibility before adding `@effect/vitest`; migrating to `it.effect` alone is not proof |
| First, independent  | F25 controlled run cancellation, F30                                                       | None                                                                           | Stop can abort a run while `next()` is pending; hanging `return()` cannot retain registry entries or prevent process teardown; reset/new-run races preserve workspace ownership and suppress late events                  |
| 5a, in flight       | Complete narrow query reads and ledger row decoding                                        | Current file owner                                                             | Updated measurement reports rows, columns, wall time, heap and payload parity; committed call projection and uncommitted Schema edits are reported separately                                                             |
| Observation         | Worker sink injection for Logger, Tracer and OperationalLog, F28                           | Existing root and `oplog` event                                                | A real worker Effect log, counter and repository span arrive at main once, with worker context and allowlisted data; default console output is not duplicated                                                             |
| Query reuse         | Request snapshot and constant provenance/session reads, F29/F33                            | 5a settled; coordinate with 6                                                  | Analytics loads summaries once; project session reads remain constant as source count grows; provenance is loaded once; pricing/config are explicit inputs                                                                |
| Renderer assessment | F35/F36 assessment of actual IPC ordering and backend hydration work                       | Preserve existing stores under the owner's implementation correction           | Keep the original renderer stores and eager refresh policy; no counters, Promise ownership or refresh coordination variables added there; consider a separate shell metadata query                                        |
| Phase 1             | Preserve typed SQL/decode failures through migrated callers, F32                           | Ledger schema edits settled                                                    | Corrupt row failures remain typed through loading; dispatch maps them to existing failure responses and an operational code; no successful empty-ledger fallback                                                          |
| Ownership           | One SQLite layer graph in WorkerLive, F27                                                  | Config/query callers prepared for direct ports                                 | One writer connection and one worker runtime; initialization precedes `ready`; rollback and future-version rejection preserved; teardown drains scopes before closing connection; MCP retains its own read-only root      |
| 6                   | Split DbWorkerContext and separate loading from calculation, F16/F29                       | 5a, Phase 1; coordinate with Ownership                                         | Loader obtains rows/config explicitly; calculations accept data without database reads or mutable module pricing state; operation set and payload semantics preserved                                                     |
| 7                   | Retire LedgerStore and inner database runtime, F12/F27                                     | Ownership and 6                                                                | All worker, FX, export, MCP, measurement and test consumers migrated; no remaining facade calls or inner runtime; retained sync execution is only at named external boundaries                                            |
| Query follow-up     | Summary/detail/search reads and measured SQL reduction; cache decision under ADR 0008, F29 | 6 and current measurement                                                      | Duplicate reads avoided within requests first; complete-turn scope and pricing parity preserved; any cache is bounded and invalidates on relevant writes/config/pricing; MCP freshness has an explicit policy             |
| Scan follow-up      | Per-scan cancellation and parser drain, F31                                                | Coordinate with 6 and 7                                                        | Delayed lookup, abort/new-scan and shutdown cases make no late writes/progress; SQLite outlives underlying parser work, not only its Effect adapter                                                                       |
| Main follow-up      | Scoped snapshot and live HarnessProbe dependency, F13/F17                                  | Independent of ledger; coordinate with Coach changes                           | Actual clientVersion reaches the probe; disposal interrupts owned work; no scope-internal state cast or unmanaged snapshot runs; coalescing and superseded responses preserved                                            |
| A6                  | Stream-based Coach workflow if it simplifies the controlled run                            | F25 stop handle and drain policy                                               | Interruption can invoke stop independently; finalizers have bounded drain; no raw `fromAsyncIterable` replacement accepted as sufficient evidence                                                                         |
| 10                  | Dedicated test tsconfig and CI typecheck, F22                                              | Can proceed independently                                                      | Tests importing Node and renderer code typecheck with required aliases/types; production configs remain separate; fix the actual surfaced errors                                                                          |
| MCP schema adapter  | Evaluate SDK registration boundary for Effect tool schemas, F37                            | Before converting shared MCP request inputs                                    | Official SDK handlers preserve tools/resources/prompts and protocol errors; metadata derives from Effect contracts; no cast to ZodRawShape or parallel hand-written contract; transitive Zod distinguished from app usage |
| Wave A              | Complete remaining main-only schema contracts                                              | Ledger work settled and contract dependency inventory                          | Convert each contract and consumers atomically using recorded parity rules; preserve typed decode errors; maintain one authoritative schema                                                                               |
| Wave B              | Convert shared wire and renderer schemas                                                   | Required dependencies, renderer decoder seam, MCP adapter where used, ADR 0034 | Accepted inputs, decoded outputs and IPC behavior preserved; renderer uses synchronous Schema validation with React/Promise runtime; remove Zod after its final consumers leave                                           |
| 11, later           | Predicate cleanup and final documentation                                                  | Touch only settled files                                                       | Replace appropriate duplicated guards without introducing schemas for pure trusted data; update architecture status and preserve ADR 0029 ownership/privacy requirements                                                  |

F25, F26 and test typechecking do not need to wait for ledger work. The ledger
rows, runtime ownership, context split and facade retirement share files and
must proceed under coordinated sequential ownership. Main snapshot and Coach
work also need coordinated ownership of `agents/ipc.ts` and `agents/runtime.ts`.
These boundaries do not require parallel agents.

Phase 1 already overlaps the in-flight ledger edits. Verify what lands before
starting it; do not repeat a completed conversion under another slice name.
Schema Wave B is authorized by A11, superseding the earlier decline in section 7.
The waves describe consumer groups; a ready leaf contract can advance without
waiting for unrelated main-only modules. The shared renderer decoder seam has
a named removal condition once its final Zod consumer migrates.
RPC and SqlModel remain declined even after Schema changes.

Completion uses the behavior and ownership checklist in the assessment, rather
than an Effect LOC percentage. Once remaining work is complete, update the
architecture status and PR description with verified results. While #148 tracks
open work, tracker maintenance should remove the PR's existing `Closes #148` line.

---

## 7. Decisions needed from the owner

> This section preserves the historical discussion and schema parity rules.
> Current decisions and dependencies are in section 6. Schema Wave B is
> authorized; RPC and SqlModel are declined; Windows CI is unscheduled.

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
> **Historical recommendation, superseded by A11 and section 6:** this RPC verdict
> originally recommended declining Wave B. The owner subsequently authorized
> replacing Zod, including synchronous Effect Schema validation in the renderer.
> Wave B is now scheduled independently of RPC, which remains declined.
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

#### Migration rules — measured, 2026-09-30

A differential parity harness walked every exported Zod schema in the tree,
synthesised a probe corpus from each schema's own structure, and compared
verdicts against candidate Effect Schemas. **Its artefacts are deliberately not
committed** — the golden was 3.2 MB and the harness is a proving instrument, not
a deliverable. What it produced is this rule set, and every rule below was
re-verified directly against `effect@4.0.0-rc.115` before being written down.

**Census.** **169** exported Zod schemas across 24 modules — not the 159 first
counted (that figure counted definition sites, not exports). **Zero**
`.refine()`, `.superRefine()`, `z.preprocess`, `z.tuple`, `.catch()`, `.brand()`.
The non-pure-validator surface is **15 sites**, all enumerated: the JSON-column
pipes and the snake→camel row transforms in `ledger.ts`, `z.coerce.number()` at
`ledger.ts:18`, two `.default()`s in `skills.ts:20-21`, the union-of-enums and
the `z.record().and()` in `renderer.ts`, two `z.custom<T>()` at `renderer.ts:41,58`,
and `.trim().min().max()` at `ipc.ts:65-66`.

**Module split.** 19 modules are renderer-facing; **5 are main-only** — `ledger`,
`pipeline`, `port`, `providers`, `session-cache`. Exact, not approximate: zero
files under `src/renderer` or `src/preload` import them. Those five are Wave A;
the other nineteen are Wave B and need the ADR 0032 amendment first.

| #      | Rule                                                                                                  | Why it matters                                                                                                                                                                                                                                                                                                                                                    |
| ------ | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1** | `z.enum([...])` → `Schema.Literals([...])`. **NEVER `Schema.Literal(a, b, c)`.**                      | Verified: `Schema.Literal.length` is **1** and the AST of a 3-argument call holds `literal: "overview"` only — the rest are **silently dropped**. A 3-member Section enum accepted 1 of 3. 16 sites, up to 16 members. Written blind, the renderer rejects `"sessions"` and every Section switch breaks.                                                          |
| **R2** | `z.number()` → `Schema.Number.pipe(Schema.check(Schema.isFinite()))`. **Never bare `Schema.Number`.** | Verified: Zod rejects `NaN`/`±Infinity`, `Schema.Number` accepts all three. A `NaN` that slips through renders as `{"cost":null}`. **309 sites** — the largest single rule.                                                                                                                                                                                       |
| **R3** | `z.coerce.number()` must be translated explicitly, never implicitly.                                  | Diverges on `""`, `null`, `true`, numeric strings — all of which Zod coerces to a number. Scoped to **24 fields**, all via `num` at `ledger.ts:18`.                                                                                                                                                                                                               |
| **R4** | `.trim()` → a _transforming_ trim. `isTrimmed()` only **checks**.                                     | `ipc.ts:65-66`. Zod accepts `"  a  "` and decodes to `"a"`; the naive translation rejects it. Order matters in Zod too: `.min(1).trim()` accepts `"   "` and decodes it to `""`.                                                                                                                                                                                  |
| **R5** | `.default(x)` → `Schema.withDecodingDefault(Effect.succeed(x))`.                                      | A bare value dies with `Not a valid effect: 5` — a **defect**, so it never surfaces as a wrong verdict, only as a crash. `skills.ts:20-21`.                                                                                                                                                                                                                       |
| **R6** | `z.record(...).and(z.object({...}))` **keeps unknown keys**.                                          | `renderer.ts:90-93`. Every other object in the tree strips. Depends on which side of `.and()` is the record.                                                                                                                                                                                                                                                      |
| **R7** | Do **not** reach for `Schema.Struct(fields, { onExcessProperty: 'fail' })`.                           | Silently ignored in rc.115. The obvious escape hatch for a strict read does not work — a version-pinned landmine.                                                                                                                                                                                                                                                 |
| **R8** | The throwing JSON `.transform()` is a deliberate behaviour change.                                    | `ledger.ts:9`. Today a malformed JSON cell makes `safeParse` **throw** — verified `SyntaxError: Unexpected token 'o'` — so there is no verdict at all and the read dies as a defect. Effect rejects cleanly. This is the same fix as Wave A's `decodeUnknownEffect` (defect channel → error channel), but it is a **change** and is owner-approved on that basis. |
| **R9** | Excess/unknown properties need **no** action.                                                         | Verified equivalent: both decode `{"a":"x","notAField":1}` to `{"a":"x"}`. This was the largest worry about the frozen wire and it is a non-issue.                                                                                                                                                                                                                |

**Verified equivalent — translate freely:** `z.discriminatedUnion` ↔ tagged
`Schema.Union` of `Struct`s (4/4 including extra-key stripping); `z.union`;
`.or()` of enums (6/6); `z.boolean`, `z.array`, `z.record` element checks;
`z.date()` ↔ `Schema.Date` (3/3); `z.string().min(1)` ↔ `Schema.NonEmptyString`;
optional/nullable composition; and `z.custom<T>()` ↔ `Schema.Any`
(required-key-but-accepts-anything matches exactly).

**Harness limitations, stated so the rules are not oversold.** The corpus is
synthetic — derived from the schemas, not from production payloads. A divergence
needing an input outside the synthesised vocabulary (a specific malformed JSON
cell, a `__proto__` key) would not be caught. The harness bounds the space it
**explores**; it does not bound the space of possible bugs. Rejection _messages_
are not compared, by design: Zod's issue format and Effect's `SchemaError` differ,
and nothing in the frozen contract depends on them.

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
