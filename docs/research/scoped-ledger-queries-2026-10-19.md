# Scoped ledger query measurements, 2026-10-19

## Changes

Overview implements [issue #158](https://github.com/Pasquale-Favella/watchtower/issues/158).
Bounded reads use the existing call timestamp index to find candidate sessions,
then return all turns and calls for each matching `(source_id, session_id)`.
The calculation still decides which turns participate by the first ordered
call. The read window has a one-day margin on each side to admit timestamp
offsets conservatively. Lifetime reads keep the full-row path.

The same candidate-session strategy now applies to Sessions, Models, Compare,
Pull Requests, Spend, Optimize, Yield, Skills and the ledger MCP scope/call
queries. Full session history remains available for PR carry-forward and spawn
attribution. Snapshot reads also load distinct lifetime source/model identities
so pricing diagnostics retain their original provider semantics. Overview's
diagnostic remains global, as before, and uses distinct lifetime models.

Overview's `dataStart` note now uses the earliest non-empty stored call
timestamp, with a turn timestamp fallback when no non-empty call timestamp
exists. The issue accepts differences for malformed/empty timestamps and orphan
rows; regression tests cover those cases.

A separate version 2 migration adds `ledger_session(session_id)` and
`ledger_turn(session_id, turn_index)` indexes for single-session detail. It
leaves migration 1 unchanged. SQLite plan tests confirm indexed searches replace
session and turn scans, including the session lookup inside the source query.
These indexes are independent of the Overview optimization.

## Method

The baseline is `e2b2302`; the measured implementation is `a781a51`. The baseline checkout
received only the benchmark's new range operations. Both runs use the real
initializer, ingest path, application queries and native SQLite driver. The
same deterministic seed produces 50,004 and 500,004 calls over 540 days. The
custom range is August 25 through August 31, 2026, inside that history.

Each operation has a separate process and persistent worker runtime. Results
include the first request, one warmup and the median of five measured warm
requests. Native rows are driver-materialized rows, not visited SQLite pages or
decoded bytes. RSS deltas are observations across individual operations, not
production peak-memory measurements. Local developer checks overlapped parts
of the baseline run; timing medians are observational. Row counts are the
deterministic measure of pruning.

The native counter now recognizes the scoped `WITH` reads as well as ordinary
`SELECT` reads. A real SQLite regression checks that CTE rows are counted. The
baseline has no CTE reads, so its original counts are unaffected. An earlier
post-change run that omitted CTE rows was discarded and rerun after this fix.

Machine: Windows 11, Intel i7-12700H, 32 GiB RAM, Node 24.13.0.

```powershell
node scripts/measure-query-path.cjs --engine=effect --sizes=50k,500k --runs=5 --warmup=1 --ops=overview:query,overview:query:range,sessions:query:range,models:query:range,store:session,store:session:missing --out=REPORT.json
```

## Results

All operations completed without failures. Native counts agree across the five
warm samples. Times are milliseconds; RSS deltas are MiB.

### 50,004 calls

| Operation           | Median before | Median after | Rows before | Rows after | RSS before | RSS after |
| ------------------- | ------------: | -----------: | ----------: | ---------: | ---------: | --------: |
| Overview lifetime   |      1,103.48 |     1,267.10 |      68,061 |     68,072 |      14.15 |     19.28 |
| Overview seven days |        764.35 |        14.26 |      68,061 |        648 |       5.12 |      0.65 |
| Sessions seven days |      1,762.62 |        53.32 |      69,450 |      3,415 |      64.21 |      0.54 |
| Models seven days   |      1,361.02 |        53.13 |      69,450 |      3,415 |      66.93 |      0.86 |
| Session detail      |          4.36 |         3.17 |          50 |         50 |       0.01 |      0.54 |
| Missing session     |          1.47 |         0.77 |           0 |          0 |       0.09 |      0.01 |

### 500,004 calls

| Operation           | Median before | Median after | Rows before | Rows after | RSS before | RSS after |
| ------------------- | ------------: | -----------: | ----------: | ---------: | ---------: | --------: |
| Overview lifetime   |     11,662.45 |     9,810.72 |     680,561 |    680,572 |     140.51 |    135.00 |
| Overview seven days |      8,882.94 |       187.78 |     680,561 |     10,595 |      79.51 |      6.04 |
| Sessions seven days |     17,263.80 |       684.06 |     694,450 |     38,362 |     848.95 |     10.36 |
| Models seven days   |     17,138.66 |       645.33 |     694,450 |     38,362 |     806.38 |      9.22 |
| Session detail      |         25.04 |         2.97 |          50 |         50 |       0.02 |      0.04 |
| Missing session     |         21.56 |         0.74 |           0 |          0 |       0.01 |      0.00 |

At 500k, Overview's range read materializes 1.557% of its previous rows, a
98.443% reduction. Sessions and Models materialize 5.524%, a 94.476% reduction.
The scoped queries hydrate 216 candidate sessions and their full history.
Overview additionally reads 11 metadata rows; snapshots retain 27,778 lifetime
source/model rows. At 50k, the corresponding ratios are 0.952% and 4.917%.

The range-to-lifetime Overview row ratio after the change is also 1.557% at
500k. Lifetime adds 11 metadata rows and remains a full-history read. Its timing
variation is not evidence of a lifetime optimization. Detail still returns 50
rows, or zero when absent; its indexes reduce traversal rather than output size.

## Limits

This bounds complete fact hydration by candidate sessions, rather than by
individual calls. A session spanning the whole history can still be expensive.
Lifetime source metadata and distinct model identities also remain lifetime
reads. Dashboard, Analytics, Project rows, the legacy session list, Search and
Export keep their existing lifetime behavior. There is no derived-result cache,
SQL pricing or persisted aggregation.

These synthetic measurements do not establish production latency or packaged
application behavior. This change has no renderer or IPC payload changes;
packaged and cross-platform acceptance were not rerun.

## Verification

- Node, web and strict test typechecks passed.
- The full unit suite passed 259 files, with 3,163 tests passed and four skipped.
- ESLint reported zero errors and 1,034 advisory warnings. Effect diagnostics
  reported zero errors, warnings or messages across all three projects.
- Repository formatting and the production build passed.
- Standards and Spec reviews found no blocking application changes. The
  simplifier shared timestamp padding and replaced diagnostic-only repricing
  with direct pricing-availability checks.
- Full-suite verification exposed the measurement SQL extractor's assumption
  that projections were single literals. Its static evaluator now supports
  readonly column arrays, joins, templates and string concatenation, while
  rejecting dynamic expressions, mutable bindings and parameterized SQL tags.
  The extractor has 20 passing tests.
- The final measurement regressions passed 24 tests across two files, including
  native CTE row capture. Their ESLint and formatting checks passed.
