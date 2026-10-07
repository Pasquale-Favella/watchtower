# Effect application query measurements, 2026-10-07

Measured source is `e65ad24e6fc9fa68fb20537f6fbe40349f67f1cd`. [1k raw results](./effect-query-path-2026-10-07-1k.json), [50k raw results](./effect-query-path-2026-10-07-50k.json), [500k raw results](./effect-query-path-2026-10-07-500k.json). All three reports contain 26 result records and no failed or timed-out operations. Each report records the same 47 measured-source hashes, with no measured-source working-tree changes. Fixture sizes contain 1,008, 50,004, 500,004 calls respectively.

## Method

Run `node scripts/measure-query-path.cjs --engine=both --sizes=SIZE --runs=5 --warmup=1 --out=PATH` separately for 1000, 50000 and 500000. These runs were sequential on Windows 11, Node 24.13.0, an Intel i7-12700H and 32 GiB RAM, after the other local verification processes finished. Raw reports retain the machine details, deterministic seed and fixture shape, database size, selected operations, source hashes, samples, first-request timings, memory observations and executed SQL.

The actual shared initializer and LedgerIngest build the synthetic ledger. Each Effect operation child owns one persistent initialized worker runtime and the actual native SQLite client. Capture pricing/proxy inputs once for that child. Measure the first request after opening the runtime, one additional warmup, then five warm requests. First-request measurements do not flush the OS file cache. Record native statement executions, SELECTs, materialized rows and connection identity for cold and warm requests. Module loading and runtime initialization are outside the operation timer.

The explicit legacy engine measures the remaining current compatibility builders at the same source revision and fixture. It is not a historical pre-migration baseline. Legacy cold timing and native execution counters are unavailable. Its export read only constructs projects, while the current query assembles the export payload and reads currency; those durations are not equivalent workloads. Keep these limits when comparing results. Retire the optional legacy engine when its comparisons are saved and the remaining compatibility callers migrate.

## Warm latency

All values are milliseconds, the median of five warm requests. Individual samples, minimum/maximum and first-request latency remain in the raw reports. These are local measurements, not general speedup claims.

| Operation             |     1k |      50k |      500k |
| --------------------- | -----: | -------: | --------: |
| ingest:portIn         |   5.72 |      9.4 |      11.5 |
| fx:refresh-rate       |   2.87 |      5.5 |      4.65 |
| store:projects        |  11.98 |   921.61 |  7,748.89 |
| store:sessions        |   13.5 |      902 |   4,175.5 |
| store:session         |   5.75 |     4.42 |      23.7 |
| store:session:missing |   0.89 |     2.76 |     19.78 |
| store:search          |  10.86 |   344.89 |     4,898 |
| store:search:blank    |   0.21 |     0.24 |      0.27 |
| overview:query        |  74.95 | 3,075.51 | 35,967.79 |
| store:analytics       |  63.76 | 1,665.92 | 28,045.76 |
| store:views           |   83.8 | 1,680.46 | 37,909.17 |
| export:read           | 168.63 | 4,379.69 | 81,195.92 |

## Native reads

Cold and all five warm requests agree on these SELECT and row counts. Every nonblank operation uses native connection 1; blank search performs no native statements inside the measured operation. Runtime ownership and opening are outside that blank-search boundary.

| Operation             | SELECTs per request | Rows at 1k | Rows at 50k | Rows at 500k |
| --------------------- | ------------------: | ---------: | ----------: | -----------: |
| ingest:portIn         |                   1 |          1 |           1 |            1 |
| fx:refresh-rate       |                   2 |          2 |           2 |            2 |
| store:projects        |                   5 |      1,372 |      68,061 |      680,561 |
| store:sessions        |                   5 |      1,372 |      68,061 |      680,561 |
| store:session         |                   6 |         50 |          50 |           50 |
| store:session:missing |                   6 |          0 |           0 |            0 |
| store:search          |                   4 |      1,372 |      68,061 |      680,561 |
| store:search:blank    |                   0 |          0 |           0 |            0 |
| overview:query        |                   6 |      1,400 |      69,450 |      694,450 |
| store:analytics       |                   6 |      1,400 |      69,450 |      694,450 |
| store:views           |                   6 |      1,400 |      69,450 |      694,450 |
| export:read           |                   8 |      1,402 |      69,452 |      694,452 |

These counts are rows materialized by the native driver. They do not measure selected or decoded bytes. Ingest and FX also execute writes, which the raw statement traces retain.

## Memory observations

All values are MiB, the maximum observed heap delta during the five measured operations. They are not production peak-memory measurements. The harness requests garbage collection before each sample, then reads memory immediately after the operation without a second collection. Effect samples retain the cold result and five warm results until reporting; legacy samples retain only their latest result. Those different retained baselines prevent an equivalent cross-engine memory comparison and can also affect scheduling/GC pressure. Raw reports retain RSS deltas and whole-child maximum RSS, including module loading and runtime startup.

| Operation             |    1k |    50k |     500k |
| --------------------- | ----: | -----: | -------: |
| ingest:portIn         |  1.65 |   1.69 |     1.67 |
| fx:refresh-rate       |   0.2 |    0.2 |     0.22 |
| store:projects        |  7.56 |  121.3 |   949.42 |
| store:sessions        |  7.56 | 122.26 |    951.3 |
| store:session         |  2.68 |   2.79 |      2.7 |
| store:session:missing |  0.22 |   0.21 |     0.21 |
| store:search          |   6.5 | 117.47 |   771.34 |
| store:search:blank    |  0.04 |   0.03 |     0.04 |
| overview:query        | 53.93 | 294.78 | 2,250.73 |
| store:analytics       |  48.3 | 332.59 | 2,714.24 |
| store:views           |  48.5 | 332.99 | 1,145.68 |
| export:read           | 50.96 | 394.14 | 5,773.67 |

## Limits and acceptance still open

Synthetic cached costs are fixture values. Ingest measures one portIn call, not discovery/parsing or an entire scan/refresh cycle. FX uses a controlled local HTTP response, not an external service. Export builds and serializes its JSON payload with an in-memory file writer, excluding filesystem writes. Its cloneBytes is the returned acknowledgment, not the assembled file payload. Other clone-byte values use the recorded serialization method or estimate and do not include real Electron transport time.

Complete provider scan/refresh measurements, separately measured selected/decoded bytes, and comparisons against a fixed historical baseline remain acceptance work. The current broad Overview, dashboard, analytics and export paths still load and reconstruct whole-ledger data. Statement reductions and bounded detail reads do not establish a complete product performance result.

The raw legacy aggregation note claiming an extra source read is stale. At this measured revision, aggregate.ts loads query-snapshot.ts, which reads sources once, sessions, turns and call facts plus aliases and overrides. Legacy records have no native execution counters; their note is not evidence of a duplicate source read. Preserve the original artifacts and use the current source and measured Effect counters for these claims.

## Next implementation frontier

Dashboard and analytics are the first shared candidate. The native repository currently materializes a full request snapshot, then aggregate calculations copy priced calls and reconstruct call/turn/session objects. Dashboard additionally constructs session rows before reducing its output; analytics constructs a full dashboard to take three arrays. These are source observations, not a causal profile.

Add a purpose-shaped transactional projection and ordinary TypeScript accumulators for these two payloads. The existing session summary projection is a starting point, but lacks estimated-cost, category, skill and subagent inputs. Preserve composite source/session identity, canonical checkout grouping, provider/model attribution, price aliases and overrides including zero prices, recorded-cost behavior, diagnostics, whole-turn admission and configuration freshness. Avoid building full detail objects, session rows or unused dashboard arrays. Capture the request's catalogue and proxy inputs once. Keep the existing runtime and SQL client.

Export needs a separate projection that retains full history, billing, category, tool/MCP/bash and project/repository identity while omitting unused message/PR/spawn/detail fields. Overview needs message and tool-sequence facts for correction/churn calculations and must not use an insufficient summary projection. Measure bytes, native reads, elapsed time and memory on the same fixtures after parity checks.

Retire remaining Overview, views, Skills, Optimize, Yield, aggregate and query-snapshot adapters by moving their callers onto ledger ports and application queries. Keep the frozen pre-wave reference as evidence rather than extending it into a replacement facade. Broader LedgerStore test setup migration is separate: 37 test files still mention it and 33 construct it at this revision. Installer, macOS/Linux packaged acceptance, remaining cooperative provider IO and worker decomposition also remain open.

Both renderer stores remain identical to `ce81593`. Their original scoped load and direct applyChange flow remain the baseline, without added let variables, request IDs, promise tracking or coalescing.

## Local verification at the measured revision

Node/web and strict test typechecks, full formatting, lint and production build pass. Lint reports zero errors and 1,109 advisory warnings. Focused verification passes 268 tests across twelve files. The full unit suite passes 180 files, with 2,405 passed and two skipped, in 286.46 seconds using one worker. Existing assertions and timeouts remain.

All four local Electron checks pass in 8.4 minutes. Fresh Windows x64 directory packaging passes. The full actual-package gate exits zero after boot, a real scan, onboarding, section navigation, project/session/detail/search reads, configuration CRUD, zero-price validation, exports, currency and clear/reclaim checks. Official SDK stdio and HTTP clients cover six tools, three resources, the prompt, invalid tools, bearer rejection and repeated stateless requests. Bounded Coach SDK inspection settles with the expected Codex failure and sends no billed prompt. No renderer errors are observed. The application and SDK children close, and the isolated profile is removed. Installer and cross-platform packaged checks remain separate.

The subsequent reliability review in `17159f1` fixes timeout settlement before native child closure, malformed marker JSON, missing metrics and the stale aggregation note. Successful operation timing and native measurement functions remain unchanged; the archived results retain the original e65ad24 source and annotations. Controlled checks pass for valid Effect/legacy results, nonzero exits, malformed and incomplete results, spawn failure and timeout closure ordering. The initial control fixture omitted min/max timing values; correcting that fixture allows the guard to accept the actual successful shape. A real native-query smoke run passes. A forced parent timeout writes one failure and exits 1; both smoke and timeout fixture directories are removed. Subsequent native test migrations and their current verification are recorded in the [execution record](../plans/effect-target-architecture.md). Published-head CI results are maintained in the [living assessment](https://github.com/Pasquale-Favella/watchtower/issues/148#issuecomment-5913654224).
