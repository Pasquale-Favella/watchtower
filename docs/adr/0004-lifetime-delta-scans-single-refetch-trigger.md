# Lifetime delta scans; the main process owns the scan loop; `store:changed` is the renderer's only refetch trigger

Status: accepted

The scan **always** ports lifetime (epoch → now): a cold first scan must absorb every file's full history, and a windowed scan would silently strand anything outside the window forever. The views apply their own period at read time (aggregation, ADR 0002), never at scan time — so a windowed scan is never wanted.

The main process owns the whole pipeline. A manual `⌘R`/`Ctrl+R` or the background cadence timer (`cadence.ts`: `manual`, `30s`, `1m`, `3m`, `5m`, `10m`, default `1m`) runs one scan pass that streams per-file deltas into the ledger and broadcasts a single `store:changed` event carrying the completed scan's metadata. Key properties:

- **No renderer polling** — `store:changed` is the renderer's single refetch trigger; the main process alone decides when data is fresh.
- **Coalescing** — a scan already running is not an error (`alreadyRunning` flag); background and manual scans never overlap.
- **Abortable** — every scan is abortable and reports progress per provider; abort surfaces as `ScanAbortedError`, never swallowed.
- **Stale-while-revalidate** — a failing background scan is silent and leaves the last-known data visible.
- **Config vs ledger** — `config:changed` is broadcast separately from `store:changed` (config writes apply at query time; no rebuild, no rescan).
- **FX rides the same cadence** — the background FX refresh shares the timer; it never throws, so a Frankfurter outage can never disturb the scan.

**Why:** the renderer must never be the one to decide when data is fresh (that way lies polling loops and thundering herd), and the scan must be safe to run in the background on a timer — silent on failure, coalesced, abortable, and cheap after the first pass thanks to delta porting.
