# Pino operational log, single file forwarded through main

Status: accepted

Issue #123 W5 finds no structured logger (2x `console.error` in `src`, no logger dep) and proposes `electron-log`. We use `pino` instead for the Operational log (CONTEXT.md): one JSON-lines file under `userData/logs`, owned and rotated by main only — the db-worker thread and the ledger-MCP sidecar forward records to main (worker stays Electron-free via `workerData`, sidecar stdout stays `READY`-clean), the sandboxed renderer forwards its tripwire via IPC and never writes files. Levels are info in packaged builds / debug in dev, rotation is ~5MB x3 with prune on boot, and every record follows a strict allowlist (provider name, basenames, counts, codes — never prompts, file contents, tokens, or ledger facts) per W15 and ADR 0012.

## Considered options

- **electron-log as proposed in #123**: automatic file transport in packaged apps, but rejected for the explicit pino choice — JSON lines and low overhead on the scan hot path.
- **Separate files per context (`main.log`, `db-worker.log`, `sidecar.log`)**: avoids all append races, but rejected — one file is simpler to locate and attach when Copy diagnostics lands later.
- **Raw concurrent append to one file**: simplest wiring, but rejected — worker thread + child process appending across rotation risks interleaved/corrupt lines during long scans.

## Consequences

- New `pino` dep (+ rotation helper); main owns destination, rotation, and quota.
- Worker/sidecar logging is forwarding-only by construction; log dir is injected (no `app.getPath` in worker, no stdout logging in sidecar).
- Minimal event allowlist only (boot, scan lifecycle + unparsed counts, IPC/MCP failures, harness lifecycle, tripwire); no per-file success chatter.
- Copy diagnostics bundle and backup/restore stay deferred (Top-10 #7 split).
