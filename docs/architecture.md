# Watchtower architecture

The main process owns the data pipeline. Tool session files on disk are
discovered, parsed, cached, and ported into a local SQLite ledger; every view
the UI shows is derived from that ledger at query time.

## Data flow

```
tool stores on disk (SQLite / JSONL / JSON)
        │  discovery: probe known paths per provider
        ▼
   extraction  : provider parsers read foreign blobs into parsed call records
        │       sealed by a shared zod schema: unknown keys stripped, a
        │       declared field failing its type is skipped and counted as
        │       "unparsed". A provider schema drift degrades that provider,
        │       never the whole scan.
        ▼
   session cache  : per-file fingerprints (dev/ino/mtime/size) reconcile what changed
        │
        ▼
   port-in  : per-file deltas stream into the ledger, upserted by a stable key
        │       (source_file, sessionId, dedupKey); re-ports are idempotent
        ▼
      ledger (SQLite)  : raw transcript facts, nothing materialized
        │
        ▼
   aggregation  : every view re-derives its totals at query time
```

## The ledger

The store is an **accumulating, normalized ledger** of four tables
(`ledger_source`, `ledger_call`, `ledger_turn`, `ledger_session`) holding only
what the transcripts observed: per-call facts with raw token counts and a base
cost, per-turn classification, session facts, and per-source provenance.

Because scans port *deltas* instead of rewriting snapshots:

- The **first scan is lifetime** (epoch to now), so no file's history is ever
  stranded; later scans only touch files whose fingerprint changed
- A `modified` file is replaced atomically; a durable provider (one that
  union-merges) never loses pruned-span history
- Config changes (aliases, price overrides, currency) repaint views instantly;
  the ledger never stores a computed cost, only tokens plus base price
- Five single-column indexes keep query-time aggregation sub-second on a full
  local history

## The extraction seam

Every provider's parsed call record flows through one shared zod schema
(`src/shared/schemas/providers.ts`) before it can become a cached call or a
ledger row. The same schema library is the single source of truth for ledger
rows, IPC payloads, and view shapes, compiled into both the node and web
tsconfigs. The renderer validates each IPC payload on arrival as a cheap
tripwire, rendering an error state rather than garbage.

Scan metadata carries per-provider **unparsed** counts, so a vendor's schema
drift is visible in the UI instead of silently corrupting totals.

## The scan loop

The main process owns the pipeline. A manual `⌘R`/`Ctrl+R` or the background
cadence timer runs one scan pass that streams per-file deltas into the ledger
and broadcasts a single `store:changed` event, the renderer's only refetch
trigger. There is no renderer polling loop. Scans coalesce (a background scan
and a manual scan never overlap), a failing background scan leaves your
last-known data visible (stale-while-revalidate), and every scan is abortable
and reports progress per provider.

## Architecture decisions

Key decisions are recorded as ADRs in [`docs/adr`](./adr) and referenced
inline in the code. The most relevant ones:

- [ADR 0002: the ledger is an accumulating store of raw facts; every view is a query-time derivation](./adr/0002-accumulating-ledger-query-time-aggregation.md)
- [ADR 0003: shared zod schemas as the single source of truth, with a loose extraction seam that degrades provider drift instead of failing the scan](./adr/0003-shared-zod-schemas-extraction-seam.md)
- [ADR 0004: lifetime delta scans; the main process owns the scan loop; `store:changed` is the renderer's only refetch trigger](./adr/0004-lifetime-delta-scans-single-refetch-trigger.md)
- [ADR 0005: sandboxed renderer, a typed IPC surface, a frozen wire contract, and a renderer-side tripwire](./adr/0005-sandboxed-renderer-ipc-tripwire.md)
- [ADR 0009: USD-anchored store; currency conversion only at the display/export boundary](./adr/0009-usd-anchored-fx-boundary.md)
- [ADR 0012: local-first privacy, no telemetry, manual informational updates](./adr/0012-local-first-privacy-manual-updates.md)
- [ADR 0015: cross-platform packaging and CI](./adr/0015-cross-platform-packaging-and-ci.md)
