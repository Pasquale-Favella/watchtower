# Slice 0: the query path, measured

> Research, no production code changed. Measured 2026-09-29 on
> `146-ledger-schema-migrations` at `9756030`. The finding under test is §3 of
> [`effect-v4-electron.md`](./effect-v4-electron.md) and slice 0 of its §5.
> Harness: [`scripts/measure-query-path.cjs`](../../scripts/measure-query-path.cjs).
>
> **Verdict: PARTLY CONFIRMED.** Time and memory are far worse than the finding
> implied — a single `store:views` request costs **19.3 s** and **2.9 GiB** of
> worker heap on a 500k-call ledger. The structured-clone half of the finding is
> **refuted**: the bulk reads never cross the `worker_threads` boundary, and the
> payload that does is **22 KiB**, not the 456 MiB the read materialises. One
> number in the finding is **wrong**: `getCalls` selects **38** columns, not 37.

---

## 1. What was measured, and on what

The §3 finding is a static reading. This is the same reading with a stopwatch.

**Real, not reproduced.**

| Thing            | How it is real                                                                                                                            | Source                                                           |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Schema           | `new LedgerStore(path)` runs migration 1 `initial_ledger_schema` through `Migrator.fromRecord`                                            | `store/ledger.ts:66-212`, `store/sqlite-migrations.ts:24`        |
| Rows             | ported by the real `portIn`, so every `*_json` blob, `base_cost_usd` and generated `call_key` is whatever the pipeline's own mapper emits | `store/ledger.ts:227` → `store/port.ts:37`                       |
| The four reads   | `LedgerStore.getCalls()` etc. — `runRepositorySync` → `LedgerRepository` → `SqlClient` → `node:sqlite` → `z.array(rowSchema).parse`       | `store/ledger-repository.ts:111-153`                             |
| Aggregation      | the real `buildSessionSummaries`                                                                                                          | `store/aggregate.ts:493`                                         |
| Section payloads | the real `buildDashboardViewsFromLedger`, `buildAnalyticalViewsFromLedger`, `buildOverviewFromLedger`, `buildProjectsFromLedger`          | `views.ts:381`, `views.ts:84`, `overview.ts:725`, `views.ts:277` |

Only two things are synthetic: the _content_ of the transcripts and the _count_
of rows. The harness never runs the app, Electron, or a `worker_threads`
boundary — it calls the same functions the `store:views`, `store:analytics`,
`overview:query` and `export:csv` dispatch arms call, in a plain process. Those
arms are cited by name rather than by line throughout, because
`db-worker/context.ts` is being edited by other slices in this tree; the lines
observed at `9756030` are `store:views` `:585`, `store:analytics` `:755`,
`overview:query` `:758`, `export:csv` `:834`.

**Two shims, both outside the measured code.** This repo has no `tsx` and no
`ts-node`, and this slice adds no dependency, so the harness installs a
CommonJS transpile hook (`typescript.transpileModule` plus a `.js` → `.ts`
resolver) to load the real `src/main` TypeScript:

- `import.meta.url` → `require('node:url').pathToFileURL(__filename).href`.
  TypeScript emits `import.meta` verbatim into CommonJS output, which Node then
  misreads as ES-module syntax. The only occurrence on the measured path is
  `pipeline/sqlite.ts:8`.
- compiler options mirror `tsconfig.node.json` (`ES2022`, `esModuleInterop`,
  `useDefineForClassFields` at its ES2022 default).

Neither shim touches SQL, Zod, or a view builder.

**No DDL is transcribed.** The migrations run. Drift is made _detectable_
rather than papered over by copying: `assertSchemaMatchesSource` compares
`PRAGMA table_xinfo` for all four `ledger_*` tables and the five
`idx_ledger_call_*` indexes against the column lists transcribed from
`store/ledger.ts:71-162`, and aborts the run on any mismatch. That guard earned
its keep on its first execution: it caught that `call_key` is a `STORED`
**generated** column (`store/ledger.ts:124`) and is therefore absent from
`PRAGMA table_info`. A transcribing harness that had used `table_info` would
have "validated" a 37-column table — and 37 is exactly the number §3 reports.

**The static facts are read from the source, not asserted.** The harness
extracts each read's SQL template literal out of
`src/main/store/ledger-repository.ts` at run time and reports `WHERE`/`LIMIT`
presence and the selected-column count as measured outputs, printing a `NOTE`
when any differs from the values this study recorded. The same extracted text is
what the SQL-only attribution runs execute, so the attribution compares the real
query against the real query.

## 2. Method

**Ledger shape.** One `ledger_source` + `ledger_session` row per session-cache
file, `turnsPerSession` turns each, `callsPerTurn` calls each, so
`sessions = ceil(calls / (turns × calls))`. Defaults 12 × 3 = 36 calls per
session. Prompt text is padded to `msgBytes` (default 512) because `getTurns`
selects `user_message` for every turn; token counts, tool lists and costs are
plausible fixed-shape values. Every one of these is a flag
(`--turns-per-session`, `--calls-per-turn`, `--msg-bytes`, `--tools-per-call`,
`--seed`) and every one is echoed into the result, because `msgBytes` is the
knob that would move `getTurns` most.

**Timing.** Each operation runs in its own child process (`--expose-gc`, one
operation per process) so the reported memory delta belongs to that operation
and not to its neighbours. Inside a child: 1 unmeasured warm-up, then **5**
measured iterations, each preceded by an explicit `global.gc()`. The reported
wall-clock is the **median** of those 5; min and max are printed beside it so
the spread is visible rather than hidden.

**Memory.** Two measured figures per operation: the max over runs of
`process.memoryUsage().rss` growth across one iteration, and the same for
`heapUsed`. RSS growth legitimately reads `0 B` when the heap still has
headroom, which is why the heap figure sits beside it. A third, process-wide
figure — `process.resourceUsage().maxRSS`, including module load and DB open —
is in the JSON as `childMaxRssBytes`; for the `reads` bundle it covers all nine
operations, not one.

**Clone bytes.** `v8.serialize(value).byteLength` on the operation's actual
return value: the encoding `postMessage` uses. Exact for payloads up to 2,000
rows; above that the harness serializes the first 2,000 rows, divides by 2,000
and multiplies by the length, and the JSON labels the result
`derived: mean of first 2000 rows x N`. Per-column breakdowns are always
derived, over the same 2,000-row sample.

**Safety.** Everything lives in a `mkdtemp` directory removed on exit.
`openLedger` refuses any path that does not resolve inside that directory, so
the script cannot open a real user ledger even by accident. A child that
exceeds `--timeout` is killed and reported as `TIMEOUT … no number reported` —
never as a fast result.

**Sizes.** `--sizes` defaults to `1k,50k,500k` and accepts `k`/`m` suffixes, so
`--sizes=5m` is a flag, not a code change.

**Machine.** Windows 11 Enterprise 10.0.26200 x64, Intel Core i7-12700H
(14 cores / 20 logical), 31.7 GiB RAM, Node **v24.13.0**. The synthetic ledger
is built and read under `%TEMP%` on the same NVMe volume (KIOXIA
KBG50ZNS512G), so the page cache is warm after the warm-up iteration.
Measured code = commit `9756030`; `git status` shows `store/ledger.ts`,
`store/ledger-repository.ts`, `store/aggregate.ts`, `store/port.ts`,
`store/node-sqlite-client.ts`, `views.ts`, `overview.ts`, `pipeline/parser.ts`
and `shared/schemas/ledger.ts` all **clean** for the duration.
`db-worker/context.ts` was dirty (another slice was editing it) but is only
cited, never imported by the harness.

## 3. Results

Wall-clock is the median of 5 runs in an isolated child process. `RSS Δ` and
`heap Δ` are the max over those runs of the memory growth across **one**
operation. `clone` is the structured-clone size of the operation's return
value. `wire` is whether that value actually crosses the `worker_threads`
boundary in production — see §5.2, where this is where the finding breaks.

### 1,008 `ledger_call` rows — 28 sessions, 336 turns, 1.0 MiB db, 0.3 s to build

| operation                                 |   median | min .. max     |   RSS Δ |   heap Δ |        clone |  rows |  wire   |
| ----------------------------------------- | -------: | -------------- | ------: | -------: | -----------: | ----: | :-----: |
| `read:getSources`                         |   1.1 ms | 0.9 .. 1.6     |     0 B |  0.1 MiB |      9.4 KiB |    28 |   no    |
| `sql:getSources` (no Zod)                 |   0.5 ms | 0.4 .. 0.5     |     0 B |  0.1 MiB |     10.4 KiB |    28 |   no    |
| `read:getSessions`                        |   1.5 ms | 1.0 .. 1.9     |     0 B |  0.2 MiB |     12.1 KiB |    28 |   no    |
| `sql:getSessions` (no Zod)                |   0.5 ms | 0.4 .. 0.6     |     0 B |  0.1 MiB |     13.0 KiB |    28 |   no    |
| `read:getTurns`                           |   4.1 ms | 2.6 .. 5.9     | 0.1 MiB |  1.7 MiB |      253 KiB |   336 |   no    |
| `sql:getTurns` (no Zod)                   |   1.8 ms | 1.2 .. 2.1     |     0 B |  0.6 MiB |      258 KiB |   336 |   no    |
| `read:getCalls`                           |  16.9 ms | 15.0 .. 30.7   | 0.1 MiB | 14.2 MiB |      0.9 MiB | 1,008 |   no    |
| `sql:getCalls` (no Zod)                   |   7.7 ms | 5.8 .. 11.7    |     0 B |  2.3 MiB |      1.0 MiB | 1,008 |   no    |
| `agg:buildSessionSummaries`               |  47.1 ms | 42.6 .. 73.8   | 1.9 MiB | 26.1 MiB |      0.9 MiB |    28 |   no    |
| `aggregate:buildSessionSummaries` (alone) |  67.8 ms | 58.7 .. 97.3   | 1.2 MiB | 24.1 MiB |      0.9 MiB |    28 |   no    |
| `export:read` (`buildProjectsFromLedger`) |  49.6 ms | 36.6 .. 75.3   | 0.5 MiB | 24.4 MiB |      0.9 MiB |     7 |   no    |
| **`store:views`**                         |  55.4 ms | 53.7 .. 71.7   | 1.7 MiB | 24.5 MiB |  **2.7 KiB** |     – | **yes** |
| **`store:analytics`**                     |  92.5 ms | 89.2 .. 119.3  | 2.7 MiB | 44.9 MiB |  **1.4 KiB** |     – | **yes** |
| **`overview:query`**                      | 120.9 ms | 114.6 .. 129.8 | 3.0 MiB | 51.8 MiB | **33.4 KiB** |     – | **yes** |

### 50,004 `ledger_call` rows — 1,389 sessions, 16,668 turns, 42.2 MiB db, 36.5 s to build

| operation                                 |   median | min .. max     |     RSS Δ |    heap Δ |        clone |   rows |  wire   |
| ----------------------------------------- | -------: | -------------- | --------: | --------: | -----------: | -----: | :-----: |
| `read:getSources`                         |   9.9 ms | 9.3 .. 10.3    |   0.6 MiB |   3.6 MiB |      469 KiB |  1,389 |   no    |
| `sql:getSources` (no Zod)                 |   4.3 ms | 4.0 .. 5.0     |   0.1 MiB |   1.2 MiB |      518 KiB |  1,389 |   no    |
| `read:getSessions`                        |  16.6 ms | 15.9 .. 18.1   |   0.8 MiB |   7.9 MiB |      603 KiB |  1,389 |   no    |
| `sql:getSessions` (no Zod)                |   6.3 ms | 6.2 .. 7.2     |       0 B |   1.8 MiB |      646 KiB |  1,389 |   no    |
| `read:getTurns`                           | 362.9 ms | 304.6 .. 445.1 |  26.4 MiB |  61.3 MiB |     12.3 MiB | 16,668 |   no    |
| `sql:getTurns` (no Zod)                   | 352.4 ms | 186.6 .. 678.0 |   0.7 MiB |  26.8 MiB |     12.5 MiB | 16,668 |   no    |
| `read:getCalls`                           | 1,886 ms | 1,648 .. 2,247 |  56.6 MiB | 173.7 MiB |     45.4 MiB | 50,004 |   no    |
| `sql:getCalls` (no Zod)                   |   560 ms | 538 .. 594     |   4.3 MiB | 112.9 MiB |     47.9 MiB | 50,004 |   no    |
| `agg:buildSessionSummaries`               | 2,421 ms | 2,126 .. 2,501 |  10.0 MiB | 269.6 MiB |     44.7 MiB |  1,389 |   no    |
| `aggregate:buildSessionSummaries` (alone) | 1,967 ms | 1,458 .. 2,199 | 100.6 MiB | 274.9 MiB |     44.7 MiB |  1,389 |   no    |
| `export:read` (`buildProjectsFromLedger`) | 2,347 ms | 2,116 .. 2,488 |  86.0 MiB | 276.8 MiB |     44.7 MiB |      8 |   no    |
| **`store:views`**                         | 2,299 ms | 2,269 .. 2,516 |  86.5 MiB | 285.1 MiB | **21.2 KiB** |      – | **yes** |
| **`store:analytics`**                     | 4,863 ms | 4,257 .. 5,279 |  89.7 MiB | 497.8 MiB |  **1.5 KiB** |      – | **yes** |
| **`overview:query`**                      | 2,924 ms | 2,840 .. 3,944 |  96.4 MiB | 489.6 MiB | **38.5 KiB** |      – | **yes** |

### 500,004 `ledger_call` rows — 13,889 sessions, 166,668 turns, 423.7 MiB db, 210 s to build

| operation                                 |        median | min .. max       |     RSS Δ |       heap Δ |        clone |    rows |  wire   |
| ----------------------------------------- | ------------: | ---------------- | --------: | -----------: | -----------: | ------: | :-----: |
| `read:getSources`                         |       70.9 ms | 41.1 .. 81.2     |   1.8 MiB |     36.2 MiB |      4.6 MiB |  13,889 |   no    |
| `sql:getSources` (no Zod)                 |       39.6 ms | 38.9 .. 43.5     |   0.1 MiB |     12.1 MiB |      5.1 MiB |  13,889 |   no    |
| `read:getSessions`                        |        205 ms | 187 .. 268       |   2.6 MiB |     63.9 MiB |      5.9 MiB |  13,889 |   no    |
| `sql:getSessions` (no Zod)                |        148 ms | 136 .. 175       |   0.8 MiB |     17.8 MiB |      6.3 MiB |  13,889 |   no    |
| `read:getTurns`                           |  **7,249 ms** | 6,574 .. 7,614   | 157.0 MiB |    354.5 MiB |    122.9 MiB | 166,668 |   no    |
| `sql:getTurns` (no Zod)                   |      5,588 ms | 5,461 .. 6,446   |   4.4 MiB |    267.6 MiB |    125.4 MiB | 166,668 |   no    |
| `read:getCalls`                           | **11,464 ms** | 9,158 .. 13,422  | 755.8 MiB | **1.55 GiB** |    456.4 MiB | 500,004 |   no    |
| `sql:getCalls` (no Zod)                   |      6,067 ms | 5,988 .. 7,337   |  99.7 MiB |     1.10 GiB |    480.9 MiB | 500,004 |   no    |
| `agg:buildSessionSummaries`               |     18,654 ms | 16,893 .. 25,113 | 158.2 MiB |     2.17 GiB |    450.5 MiB |  13,889 |   no    |
| `aggregate:buildSessionSummaries` (alone) |     20,085 ms | 18,401 .. 20,805 |  1.34 GiB |     3.37 GiB |    450.5 MiB |  13,889 |   no    |
| `export:read` (`buildProjectsFromLedger`) |     17,925 ms | 17,352 .. 24,529 |  1.03 GiB |     3.27 GiB |    447.0 MiB |       8 |   no    |
| **`store:views`**                         | **19,258 ms** | 17,764 .. 23,264 | 836.0 MiB | **2.79 GiB** | **22.4 KiB** |       – | **yes** |
| **`store:analytics`**                     | **38,226 ms** | 31,989 .. 47,771 |  2.85 GiB | **5.92 GiB** |  **1.5 KiB** |       – | **yes** |
| **`overview:query`**                      | **40,814 ms** | 39,652 .. 61,678 |  1.09 GiB | **6.12 GiB** | **38.9 KiB** |       – | **yes** |

Process peak RSS (`childMaxRssBytes`, module load + open + operation) at 500k:
7,592 MiB for `overview:query`, 7,400 MiB for `store:analytics`, 6,023 MiB for
the `reads` bundle, 4,307 MiB for `store:views`.

**Per-row bytes, derived from a 2,000-row sample** (stable across all three
sizes): a `ledger_turn` row is 717 clone bytes, of which **`user_message` is
525 B — 73.2%**. A `ledger_call` row is 710 clone bytes, of which `tools_json`
94.9 B + `mcp_tools_json` 40.3 B + `tool_sequence_json` 41 B = **24.8%**.

**Run-to-run reproducibility.** Two independent invocations at 50k
(`--runs=5` each, different process lifetimes) agree closely on the aggregate
operations and disagree on two of the reads:

| operation                         |    run A |    run B | ratio |
| --------------------------------- | -------: | -------: | ----: |
| `agg:buildSessionSummaries`       | 2,421 ms | 2,456 ms | 1.01× |
| `store:views`                     | 2,299 ms | 2,283 ms | 1.01× |
| `store:analytics`                 | 4,863 ms | 4,867 ms | 1.00× |
| `aggregate:buildSessionSummaries` | 1,967 ms | 2,145 ms | 1.09× |
| `read:getCalls`                   | 1,886 ms | 1,071 ms | 1.76× |
| `overview:query`                  | 2,924 ms | 5,444 ms | 1.86× |

The 1k column is worse still: six separate invocations put `store:views`
between **22 ms and 55 ms** (30.1 / 53.1 / 55.4 / 47.9 / 22.0 / 22.9). At 1k
the numbers are dominated by JIT warm-up and machine load, not by the query
path, and should be read as an order of magnitude. The 50k aggregate figures
and the 500k figures are stable.

## 4. What this confirms and what it refutes

### 4.1 Confirmed, and quantified

**Zero `WHERE`, zero `LIMIT`.** Machine-checked on every run by extracting the
SQL text from the repository source, not transcribed: all four reads report
`hasWhere: false, hasLimit: false`. Combined with
`lifetimeRange() = { start: new Date(0), end: new Date() }`
(`db-worker/context.ts:89`), read volume is exactly the lifetime ledger, every
time.

**`getTurns` reads full prompt text.** `user_message` is 73.2% of a turn row's
clone bytes. At 500k that is 123 MiB of prompt text pulled, JSON-parsed and
Zod-validated on every read, of which the aggregation seam uses… the string
itself, for `searchSessions` and the `userMessage` field of every `SessionDetail`.
Nothing in the aggregate path reduces it.

**The whole lifetime ledger is Zod-validated on every read.** Measured by
running the identical SELECT text through the identical `SqlClient` with the
Zod parse removed:

| read                 | SQL only |     + Zod | Zod share |
| -------------------- | -------: | --------: | --------: |
| `getCalls` (500k)    | 6,067 ms | 11,464 ms |   **47%** |
| `getTurns` (500k)    | 5,588 ms |  7,249 ms |       23% |
| `getSessions` (500k) |   148 ms |    205 ms |       28% |
| `getSources` (500k)  |    40 ms |     71 ms |       44% |

`z.array(ledgerCallRowSchema).parse` over 500,004 rows of 38 columns — six of
them JSON blobs that are themselves `JSON.parse`d and re-validated — costs
**5.4 seconds per read**, and it is paid on every Section render.

**No memoisation; the multiplier is real and is now a number.** `store:views`
performs **eight** repository round-trips: `getModelAliases` +
`getPriceOverrides` (`aggregate.ts:70`), then `getSources` (`aggregate.ts:107`),
`getSessions` (`:115`), `getTurns` (`:116`), `getCalls` (`:118`), `getSources`
again (`:520`), then `getSessions` a third time in the view
(`views.ts:384`). `DbWorkerClient`'s `inflightReads` map
(`db-worker/client.ts:260-268`) only collapses _concurrent identical_ requests,
which a single-user Section switch never is. The measured consequence:

- `aggregate:buildSessionSummaries` = 20.1 s
- `store:analytics` = 38.2 s ≈ **2.0 ×** (it calls `buildSessionSummaries`
  directly at `views.ts:85` and again through `buildDashboardViewsFromLedger`)
- `overview:query` = 40.8 s ≈ **2.0 ×** (`overview.ts:725-732` calls
  `buildSessionSummaries` twice: once all-time for `dataStart`, once scoped)
- `store:views` = 19.3 s ≈ **1.0 ×** + one more `getSessions`

### 4.2 The aggregation code is not the cost — the reads are

This is the finding's one genuinely surprising result, and it cuts against the
finding's own framing ("4,905 lines of view builders [aggregating] in JavaScript
over data SQLite could have grouped").

At 500k, the five data-table reads inside `buildSessionSummaries` sum to
**19.06 s** (0.071 + 0.205 + 7.249 + 11.464 + 0.071). The measured
`buildSessionSummaries` is **18.7–20.1 s** depending on the process. So
`queryScope`'s map construction, `reconstructCall`, `reconstructTurn`,
`assembleSession` and `attachCanonicalIdentity` together cost **0–1 s, under
6%** of the function. In memory the story is different: `buildSessionSummaries`
peaks at 2.17–3.37 GiB against 1.55 GiB for `getCalls` alone, so the
aggregation adds **0.6–1.8 GiB** on top of the read it already holds in memory.

Practical consequence for slice 5: pushing `GROUP BY` into SQL is the right
instinct, but the measured win is bounded by the 6% aggregation share. The
dominant costs are `getCalls` (11.5 s) and `getTurns` (7.2 s) plus their Zod
passes (5.4 s and 1.7 s). **Cutting the column set, the `user_message` payload
and the per-read validation is worth more than re-grouping the aggregation**,
and only the first two are reachable without changing a schema or a contract.

`getSources` + `getSessions` together are 0.28 s of a 19.3 s `store:views` —
**1.4%**. The "seven/eight reads" framing overstates: it is two reads
(`getCalls`, `getTurns`) that are 97% of the time.

### 4.3 Refuted: the structured-clone claim

§3 says the reads are "each structured-cloned across the `worker_threads`
boundary". **They are not.** The worker posts `{id, op, args}` inward and the
op's return value outward (`db-worker/client.ts:253`). The ledger rows are
built, Zod-validated and aggregated on the same thread that read them; the only
thing that travels is the finished view payload. Measured clone size of the
actual return value at 500k:

| op                                 | return value crosses the wire |                  clone bytes |
| ---------------------------------- | :---------------------------: | ---------------------------: |
| `read:getCalls`                    |              no               | 456.4 MiB _(in-worker only)_ |
| `read:getTurns`                    |              no               | 122.9 MiB _(in-worker only)_ |
| `buildProjectsFromLedger` (export) |              no               | 447.0 MiB _(in-worker only)_ |
| `store:views`                      |            **yes**            |                 **22.4 KiB** |
| `store:analytics`                  |            **yes**            |                  **1.5 KiB** |
| `overview:query`                   |            **yes**            |                 **38.9 KiB** |

So the IPC cost of a `store:views` request at 500k calls is **22 KiB**, four
orders of magnitude below the 456 MiB the read materialises. The export arm is
the same story: `runExport` writes the file and returns `{ok, path}` (the
`export:csv` arm), so the 447 MiB `ProjectSummary[]` never travels either.

The finding's _substance_ survives intact — the work is real, it is just CPU and
heap on one thread rather than bytes on a wire — but any refactor motivated by
"stop cloning 456 MiB per request" would be solving a problem that does not
exist. Slice 5's `unstable/rpc` re-evaluation (§5.5 of the addendum, "evaluate
it after slice 5, when the payload volumes are known") should be read with
this in front of it: the payloads are 1–39 KiB.

**This correction also caught a bug in this harness.** The first published run
labelled `export:read` as crossing the wire, because the harness measured
`buildProjectsFromLedger`'s return value in isolation. It does not. The label
was fixed in the harness after the run; the timings, memory and byte counts are
unaffected, only the `wire` column.

### 4.4 Corrected

- **`getCalls` selects 38 columns, not 37** (`ledger-repository.ts:143-150`).
  The count is now machine-checked on every run, so §3's "37" cannot drift
  silently again. `getSources` 11, `getSessions` 16, `getTurns` 12, `getCalls`
  38 — and 6 of the 38 are `*_json`, which is the part that matters.
- `lifetimeRange` is at `db-worker/context.ts:89`, not `:90` (the file moved by
  one line in an unrelated slice), and the `store:views` / `store:analytics` /
  `overview:query` arms are now at `:585` / `:755` / `:758` where §3 cites
  `:567` / `:737`. That file is a moving target in this tree, which is why the
  arms are cited by name everywhere else.

## 5. Caveats

These bound every number above.

1. **One machine, one OS.** i7-12700H, 31.7 GiB RAM, NVMe. A spinning disk or a
   thermally-throttled laptop would change the SQL share of every figure — and
   the SQL-only attribution shows the SQL share is already 53% of `getCalls`.
2. **A shared working tree.** Other slices were editing `src/main` and
   reinstalling `node_modules` during these runs. Two `500k` operations
   (`overview:query` and `aggregate:buildSessionSummaries`) failed on the first
   canonical invocation with `Cannot find module '@pinojs/redact'` — an install
   artefact, not a query-path result — and were re-measured afterwards on a
   stable `node_modules`; the table above carries the re-measured values. The
   nine measured source files were `git clean` for the whole duration, and the
   harness now records their sha256 prefixes in `git.measuredSources` so a
   future mismatch is visible.
3. **The machine was not idle.** Medians of 5 and printed min..max make
   contention visible, and §3's reproducibility table quantifies it, but a run on
   an idle machine would be tighter.
4. **The synthetic content is a model, not a transcript.** `msgBytes` is the
   parameter that would move `getTurns` most; its per-column share (73.2%) is
   reported so the sensitivity is legible without a re-run. A heavy real user is
   also lopsided — a few huge sessions, many small ones — where the default
   36-calls-per-session uniform shape is optimistic for the tail.
5. **500k calls is an extreme ledger.** 13,889 sessions over 18 months is one
   session per day for a year and a half. The 50k row (1,389 sessions) is the
   more representative heavy case, and it is still bad: **2.3 s** and 285 MiB
   for one `store:views`, **4.9 s** and 498 MiB for `store:analytics`.
6. **Not a freeze measurement.** ADR 0023 moved this to a worker thread so the
   _UI_ stops freezing. These are worker-thread CPU and memory. Making the work
   smaller helps both; making the UI wait for it helps only the second.
7. **A 5M-row projection is arithmetic, not a measurement.** Scaling the 500k
   median by the observed 50k→500k factor (6.1×–14× for the fast ops, ~8–10×
   for the aggregate ops) puts `store:views` in the **2–3 minute** range and
   `overview:query`'s heap at **tens of gigabytes** — which would not fit on
   this machine. That is a projection from a measured slope, deliberately not
   measured, and `--sizes=5m --max-old-space=24576` will settle it. Do not
   quote those numbers as measurements.
8. **`base_cost_usd` is synthetic.** The harness supplies `costUSD` on the
   cached call, which `cachedCallToApiCall` prefers over the pricing table
   (`pipeline/parser.ts:3033`). The real `calculateCost` is therefore not on the
   measured path; the only pricing work measured is `resolveDisplayCost`'s
   per-row map lookup.

## 6. Reproducing

```
node scripts/measure-query-path.cjs --help
node scripts/measure-query-path.cjs --sizes=1k,50k,500k --runs=5
node scripts/measure-query-path.cjs --sizes=500k --ops=store:views --json
node scripts/measure-query-path.cjs --sizes=5m --runs=5 --max-old-space=24576
```

The 3-size sweep above took 22 minutes of wall clock (210 s of it building the
500k ledger through the real `portIn`). Node's `node:sqlite` is experimental
and prints a warning on first use; that is expected and is also true in
production (`pipeline/sqlite.ts`).

Raw per-run samples, per-column byte breakdowns and `childMaxRssBytes` are in
the `--json` / `--out` payload. Nothing in this document is a number that is not
in that payload.
