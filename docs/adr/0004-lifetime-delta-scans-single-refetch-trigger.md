# Lifetime delta scans; the db-worker owns the scan loop; `store:changed` is the renderer's only refetch trigger

Status: accepted

The scan **always** ports lifetime (epoch → now): a cold first scan must absorb every file's full history, and a windowed scan would silently strand anything outside the window forever. The views apply their own period at read time (aggregation, ADR 0002), never at scan time — so a windowed scan is never wanted.

Under [ADR 0023](./0023-db-worker-data-plane.md), the db-worker owns the pipeline and scan lifecycle. Main forwards manual `⌘R`/`Ctrl+R` requests and relays worker events to the renderer. The worker's Effect supervisor owns background cadence (`cadence.ts`: `manual`, `30s`, `1m`, `3m`, `5m`, `10m`, default `1m`), scan fibers, cancellation, and shutdown under ADR 0032. Each scan streams per-file deltas into the ledger and reports completion through `store:changed`. Key properties:

- **No renderer polling.** `store:changed` is the renderer's single refetch trigger; the worker decides when a scan has completed and main relays the event.
- **Coalescing.** A scan already running is not an error; background and manual scans never overlap.
- **Abortable.** Every scan supports interruption and reports progress per provider; cancellation remains distinct from a successful scan.
- **Stale-while-revalidate** — a failing background scan is silent and leaves the last-known data visible.
- **Config vs ledger** — `config:changed` is broadcast separately from `store:changed` (config writes apply at query time; no rebuild, no rescan).
- **FX shares the cadence.** The worker owns background FX refresh alongside scan scheduling; a Frankfurter outage never disturbs the scan.

**Why:** the renderer must never be the one to decide when data is fresh (that way lies polling loops and thundering herd), and the scan must be safe to run in the background on a timer — silent on failure, coalesced, abortable, and cheap after the first pass thanks to delta porting.
