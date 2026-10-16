# Watchtower architecture

The main process owns the application control plane. The db-worker owns the
data pipeline: it discovers and parses tool session files, maintains the
session cache, and writes per-file changes to the local SQLite ledger. Views
derive their results from that ledger at query time.

## Data flow

```
tool stores on disk (SQLite / JSONL / JSON)
        │  discovery: probe known paths per provider
        ▼
   extraction  : provider parsers read foreign blobs into parsed call records
        │       sealed by a shared Effect Schema: unknown keys stripped, a
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

Because scans port _deltas_ instead of rewriting snapshots:

- The **first scan is lifetime** (epoch to now), so no file's history is ever
  stranded; later scans only touch files whose fingerprint changed
- A `modified` file is replaced atomically; a durable provider (one that
  union-merges) never loses pruned-span history
- Config changes (aliases, price overrides, currency) repaint views instantly;
  the ledger never stores a computed cost, only tokens plus base price
- Indexes support query-time reads over the accumulating local history

## The extraction seam

Every provider's parsed call record flows through one shared Effect Schema
(`src/shared/schemas/providers.ts`) before it can become a cached call or a
ledger row. Effect Schema is the authority for migrated provider, ledger, and
IPC contracts. The renderer decodes incoming payloads synchronously with
Effect Schema and reports invalid payloads through its existing error state
and tripwire. One UI-only schema module remains plain TypeScript. The renderer
uses no Effect runtime, layers, or services, and its Promise-based IPC facade
and local state flow remain unchanged. The installed MCP SDK still uses Zod
internally; that dependency does not define Watchtower's contracts.

Scan metadata carries per-provider **unparsed** counts, so a vendor's schema
drift is visible in the UI instead of silently corrupting totals.

## The scan loop

The main process sends manual `⌘R`/`Ctrl+R` requests to the db-worker. The
worker also owns background cadence and scan lifecycle. Each scan streams
per-file deltas into SQLite and reports progress and completion to main, which
relays events to the renderer. `store:changed` remains the renderer's only
refetch trigger. There is no renderer polling loop. Scans coalesce, a failed
background scan leaves the last-known data visible, and each scan supports
abort and per-provider progress.

## The coach surface

The **Coach & Skills** section (ADR 0017) is a chat with the user's own
coding-agent CLIs. The main process drives one harness per conversation over
the Agent Client Protocol through a single `HarnessRuntime` seam (ADR 0016): a
data-driven registry of one spec file per drivable CLI (`agents/harnesses/`),
the AI SDK + `@mcpc-tech/acp-ai-provider` wired lazily, and a typed
`CoachEvent` stream the renderer derives into bubbles (text, thinking, tool
notices). Model/mode selection is progressive — the agent's handshake declares
what it supports (ADR 0018). Every run attaches the in-app `watchtower-ledger`
MCP server (ADRs 0019/0020): read-only access to the full lifetime ledger,
filtered by the agent itself through each tool's optional `scope` argument.
There is ONE agent with TWO scopes (ADR 0021) — a coaching question and a
skill request are the same mode-less coach run; the suggested-skill chips on
the welcome screen are plain chat-starters that ask the agent to author a
SKILL.md grounded in the ledger.

## The Effect-first backend

Effect is the composition model for effectful backend workflows in the main
process, the db-worker, and the Harness integration (ADR 0032, accepted and
authoritative). Adoption moves one vertical slice at a time: each migrated
workflow uses Effect end to end for orchestration and effectful dependencies,
while behavior and IPC contracts stay stable. Pure parsing, mapping,
aggregation, and formatting stay ordinary functions.

### Current ownership

The main process owns windows, IPC, harness coordination, and the pooled MCP
sidecar lifecycle. Its `MainRuntime` composes those services with HTTP,
configuration, logging, metrics, and tracing. The db-worker owns the scan
pipeline, cadence supervisor, initialized Effect/SQL graph, and single-writer
SQLite connection. It keeps database work off the Electron main thread. MCP
query processes use a separate read-only runtime and connection; they never
share the worker's SQLite state.

The Electron root also composes `BackgroundShell` into that same runtime.
Its scoped Layer owns the tray, orb windows, IPC and display subscriptions,
and delayed visibility, readiness, reveal and peek work. Native callbacks enter
scoped fibers through Effect's `FiberMap` bridge; delays and held-request age
use the captured Clock. Quit blocks new shell activity, interrupts pending tray
acquisition and delayed work, then runtime disposal releases subscriptions and
windows. The first-close explanation is consumed only when its panel appears.
Shell preferences retain their existing `shell-preferences.json` representation,
with a Schema-derived contract and typed read, decode and write failures.

Effect owns backend orchestration, service composition, typed failures,
scoped resources, fibers, schedules, and time-dependent policy. Provider IO and
session-cache IO use native Effects; pure parsing and transformations remain
plain functions. Node's SQLite driver is synchronous, so each repository
operation executes its complete transaction without Promise yields. Effect
does not make an individual SQL statement non-blocking. External Node,
Electron, SDK, and Promise APIs remain leaves at their existing boundaries.

The 23-module owned-schema baseline has no Watchtower-owned Zod contracts:
22 modules use Effect Schema and one UI-only module uses plain TypeScript.
Renderer validation is synchronous and needs no application runtime. The
official MCP SDK may retain its own Zod protocol schemas. Compatibility
adapters remain only where direct Promise, framework, SDK, or test callers use
them; each has a documented removal condition tied to those callers.

Effect Logger, Metric, and Tracer use the existing sanitized operational-log
writer. Main and worker have separate in-memory metric registries. The worker
forwards records to main through its existing event channel. No exporter or
second logging sink is installed.

Locked decisions carried over from the adoption follow-up:

- Configuration is env-only through Effect Config. Persisted settings —
  Aliases, Price overrides, and other user settings changed at runtime —
  stay in the ledger repository. There is no unified app config.
- Any platform-layer adoption is sequenced HttpClient, then FileSystem, then
  Command, each step pinned to the `effect` release line and proven inside
  the packaged artifact the way `effect` itself was. **Re-specified against
  what `effect@4.0.0-rc.115` actually ships:** there is no Effect-v4
  `@effect/platform` (every release peer-depends on Effect v3), and rc.115 ships
  the in-package modules instead — `effect/unstable/http` for step 1 (landed),
  `effect/unstable/process` (`ChildProcess` + `ChildProcessSpawner`) for step 3
  (landed, one tracer call site: the Claude auth probe, behind the
  `CommandRunner` port). `FileSystem` (step 2) is **closed as "no"** — owner
  decision, 2026-09-29: the ~20 `node:fs` reads it would cover are synchronous
  discovery reads that must resolve before any Effect context exists, so the
  transport would buy substitution no test uses and lifecycle no resource needs.
  The boundary rule that keeps this an exception rather than a spreading
  default: **sync discovery stays plain functions on `node:fs`; effectful,
  streamed, retryable, or scope-owned file work goes through a port**
  (`CommandRunner` is the existing example). No new dependency is needed for
  steps 1 or 3, and the packaged artifact needs no new external.
- Observability is a bridge, not a second pipeline: Effect logs, metrics,
  and spans feed the existing Effect-`Logger`/`Tracer`-backed Operational log
  (ADR 0029). There is no separate exporter and no third-party logging
  dependency.

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
- [ADR 0016: data-driven harness registry and the ACP runtime seam](./adr/0016-data-driven-harness-registry.md)
- [ADR 0017: unified Coach & Skills section](./adr/0017-unified-coach-skills-section.md)
- [ADR 0018: ACP-real harness spec and progressive model/mode selection](./adr/0018-acp-real-harness-spec-and-progressive-selection.md)
- [ADR 0019: in-app ledger MCP server and per-conversation temp workspace](./adr/0019-in-app-ledger-mcp-and-temp-workspace.md)
- [ADR 0020: ledger MCP on the official SDK and shared seam](./adr/0020-ledger-mcp-on-official-sdk-and-shared-seam.md)
- [ADR 0021: one coach agent, two scopes — build-skill deleted, skills crafted conversationally](./adr/0021-single-coach-agent-two-scopes.md)
- [ADR 0025: ledger MCP HTTP fallback for stdio-rejecting harnesses](./adr/0025-ledger-mcp-http-fallback-for-stdio-rejecting-harnesses.md)
- [ADR 0026: pooled ledger MCP sidecar for stdio-rejecting harnesses](./adr/0026-pooled-ledger-mcp-sidecar.md)
- [ADR 0027: app-scoped local ledger MCP and startup controls](./adr/0027-app-scoped-local-ledger-mcp.md)
- [ADR 0030: targeted Effect adoption for the Coach harness layer](./adr/0030-effect-for-harness-management.md)
- [ADR 0031: version the local ledger schema with SQLite migrations](./adr/0031-versioned-ledger-migrations.md)
- [ADR 0032: Effect as the composition model for backend workflows](./adr/0032-effect-first-backend-architecture.md)
- [ADR 0034: Effect Schema as the contract authority](./adr/0034-effect-schema-contract-authority.md)
