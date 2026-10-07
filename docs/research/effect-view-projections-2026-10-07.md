# Dashboard and analytics projections, 2026-10-07

Measured source is `f91efe1623b0732836661a2f7d7fec47fb51f1ab`. The [raw artifact](./effect-view-projections-2026-10-07.json) records the actual application queries over the shared worker runtime and native SQL client at 1k/50k/500k requested calls. It has six operation records, no failures and 54 source hashes checked against the measured files. Operations and fixture sizes ran sequentially after local verification and agent work had settled. Seed and fixture shape match the earlier application-path reports.

## Read and calculation changes

Dashboard and Analytics use one LedgerViewReads call, five SELECTs in one transaction and one existing connection. The prior broad snapshot used six SELECTs. The new DTO has eight session fields, six turn fields and nineteen call fields, plus canonical aliases and strict price overrides. It omits user messages, PR references, tool/skill/bash history, spawn IDs and session details. Decode follows transaction completion.

Plain TypeScript accumulators price calls once and aggregate sufficient facts. They do not reconstruct ParsedApiCall, ClassifiedTurn, SessionSummary or renderer session rows. Analytics avoids dashboard KPI/project/time calculations. Pricing, whole-turn admission, model attribution, provider inference, positive savings, diagnostics, current configuration and stable ordering retain parity. Numeric bucket enumeration retains the prior object ordering.

Project grouping and proxy attribution now join on source/session identity. Two sources with the same public session ID retain their separate checkout and cost. This intentionally corrects the prior public-ID-only lookup; hardcoded pure and native regressions cover it.

## Observed timings and input size proxies

Each operation records its first request after runtime opening, one unmeasured warmup and five warm samples. Milliseconds cover the application query, including wire-schema validation and pricing diagnostics. Module/runtime startup and output cloning are outside that interval. Every cold and warm request performs five SELECTs on connection 1.

| Actual calls | Operation       | Cold ms | Warm median ms | Selected rows | Raw V8 bytes | Decoded DTO V8 bytes |
| -----------: | --------------- | ------: | -------------: | ------------: | -----------: | -------------------: |
|         1008 | store:analytics |   53.01 |          18.22 |          1372 |       448705 |               453855 |
|         1008 | store:views     |    51.6 |          18.02 |          1372 |       448705 |               453855 |
|        50004 | store:analytics |   547.1 |         541.74 |         68061 |     22365763 |             22678165 |
|        50004 | store:views     |  900.64 |          713.2 |         68061 |     22365763 |             22678165 |
|       500004 | store:analytics | 8653.65 |        5729.29 |        680561 |    223966087 |            227243906 |
|       500004 | store:views     | 6765.83 |        7106.26 |        680561 |    223966087 |            227243906 |

The input probe is an additional read after timing, using the same runtime/client. It retains native selected arrays without serializing inside statement interception, then measures both raw rows and the decoded DTO with node:v8.serialize. These are serialization size proxies, not physical SQLite bytes or Electron transport timings. They exclude the pricing catalogue and calculation intermediates. The raw artifact retains statement SQL and connection checks.

Method version 2 releases each operation result before the next sample's requested GC. Samples retain scalar metrics and native execution metadata; only the final warm result produces clone metadata, after timer and memory reads. Child maximum RSS covers startup through timed samples and excludes the later input probe. Memory deltas remain process observations, not production peak-memory acceptance.

At 500k, the maximum observed heap delta is 963.9 MiB for Analytics and 962.6 MiB for Dashboard. Child maximum RSS through timed samples, including startup, is 2,068.8 and 2,078.8 MiB respectively. Analytics warm samples range from 5.69 to 17.35 seconds; Dashboard from 6.52 to 8.78 seconds. Allocation and response-time variation remain performance work. The next profiling task separates native materialization, Schema decoding and accumulation costs before choosing bounded row consumption or SQL aggregation.

The [earlier e65ad24 artifacts](./effect-query-path-2026-10-07.md) used different result retention, which can alter GC pressure and timings. No clean before/after speedup or memory reduction is claimed from those numbers. A controlled historical comparison, complete provider scan/refresh profiling, and physical selected/decoded-byte instrumentation remain open. Overview and export retain their broad projections.

## Verification

Node/web and strict test types, full formatting, build and lint pass. Lint has zero errors and 1,109 advisory warnings. Focused integration passes 156 tests across ten files; the native ordering follow-up passes 59 across two. Full units pass 183 files, 2423 tests and 2 skips in 356.15s with one worker. Existing assertions and timeouts remain. All four Electron checks pass in 7.8m. Fresh Windows x64 directory packaging and the full actual-package IPC/SDK gate exit zero. No renderer errors occur; app and SDK children close and the isolated profile is removed. Installer and macOS/Linux packaged acceptance remain open.

The first full run failed one native ordering fixture because its pause decorated the old snapshot port. The fixture now decorates the actual view port after the transaction. Its original assertions and timeout remain; the focused rerun and final full suite pass. Standards and Spec reviews have no unresolved blockers. Both renderer stores remain byte-identical to ce81593, without added let variables, request IDs, promise tracking or applyChange coalescing.
