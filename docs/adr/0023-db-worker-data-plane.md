# The data plane runs on a dedicated worker thread; the main process stays a thin forwarder

Status: accepted

Scan parsing, the ledger (`node:sqlite`, synchronous), and every query-time view builder (ADRs 0002/0008) run on a dedicated `worker_threads` thread — the db-worker (`src/main/db-worker/`, emitted as `out/main/db-worker.js`) — which owns the store from boot. The main process keeps windows, dialogs, IPC plumbing, updates, and the harness-agent surface, and forwards every data IPC channel to the worker as `{ id, op, args }`, relaying the worker's broadcasts (`scan:progress`, `scan:error`, `store:changed`, `scan:idle`, `config:changed`, `currency:changed`) to windows. Key properties:

- **Renderer contract frozen** — same channels, same payloads; the renderer's tripwire validation (ADR 0005) is untouched.
- **Single writer** — one ledger connection owns all reads and writes, so per-file port-in transactions, config upserts, and `clear()` stay serialized by construction. The only companion is the in-app ledger MCP server's read-only connection (a separate process, ADR 0020), which cannot take the locks a writer needs; `clear()` still treats its reclaim (`VACUUM`) as best-effort — the DELETEs are already committed, only the size display may lag.
- **Push preserved** — scan progress and store events stream worker → main → windows unsolicited, exactly like the old in-main broadcasts (manual ⌘R scans still route to the requesting window only).
- **Boot handshake, no respawn loops** — the worker posts `ready` once it owns the ledger; a boot failure (`init-error`, e.g. an unopenable DB) surfaces once via error dialog + quit and is never respawned. A worker that exits _after_ going live is recreated (WAL-safe fresh connection) while in-flight calls reject like any IPC failure.
- **Read coalescing** — identical pure-read op+args already in flight share one execution; writes and scans always execute.
- **Deliberately no pool** — a thread pool (e.g. Piscina) fits stateless task farms, not this plane: broadcasts need push (outside Piscina's request/response model), N writer connections would need busy-retry discipline, and scan/cadence/FX/session-cache state has no task affinity. One dedicated thread removes the freeze with a fraction of the machinery.

**Why:** parsing provider transcripts and aggregating a lifetime ledger are seconds of synchronous work that used to run on the main event loop — every refresh visibly froze the app. Moving the whole data plane one hop away fixes the freeze at the seam instead of in every view, and the message boundary (`protocol.ts`) is where a future parse-farm could plug in without touching main or renderer.
