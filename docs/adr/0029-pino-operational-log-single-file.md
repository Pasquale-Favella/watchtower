# Operational log, single file forwarded through main

Status: accepted (amended 2026-09-30 — transport moved off `pino`, decision otherwise unchanged)

Issue #123 W5 finds no structured logger (2x `console.error` in `src`, no logger dep) and proposes `electron-log`. The decision is not to use a logging dependency at all for the Operational log (CONTEXT.md): one JSON-lines file under `userData/logs`, owned and rotated by main only — the db-worker thread and the ledger-MCP sidecar forward records to main (worker stays Electron-free via `workerData`, sidecar stdout stays `READY`-clean), the sandboxed renderer forwards its tripwire via IPC and never writes files. Levels are info in packaged builds / debug in dev, rotation is ~5MB x3 with prune on boot, and every record follows a strict allowlist (provider name, basenames, counts, codes — never prompts, file contents, tokens, or ledger facts) per W15 and ADR 0012.

## Amendment (2026-09-30): Effect's `Logger`/`Tracer` + a hand-written writer

The file, the rotation, the allowlist and the forwarding topology are all unchanged. What changed is the transport. Originally `pino` + `pino-roll` + `pino-pretty` supplied JSON framing, ISO timestamps, the level ceiling, rotation and the dev console echo, and domain code reached the sink through a bespoke Effect-returning helper. Now:

- **Effect's own `Logger` is the one Effect-facing API.** `Effect.logInfo('scan.provider').pipe(Effect.annotateLogs({ event: 'scan.provider', provider: 'x', unparsed: 4 }))` is the call shape. Effect owns levels, annotations and spans; nothing else does.
- **A ~110-line writer in `src/main/operational-log.ts` owns the file**: `JSON.stringify(record) + '\n'`, `new Date().toISOString()`, a level ceiling, size-triggered rotation with N rotated generations beside the active file, prune on boot, and a dev-only console echo. Same 5MB x3 quota, same `count`, same `size` grammar (a bare number is MB).
- **Spans** ride a `Tracer` on the same writer, with one record per application or repository operation end. The SQL driver's per-statement `sql.execute` spans end normally but are not forwarded. Enclosing operation spans retain timing and sanitized failure codes without a log record for every statement in a scan.
- **The security reasoning is untouched and is the reason the change is safe.** `sanitizeOperationalRecord` (`src/shared/logging.ts`) is the single enforcement point between a call site and the disk, and it is pino-independent. The `redact` path list the old logger was configured with named only keys (`prompt`, `token`, `headers`, `body`, `fileContent`, …) that the allowlist had already dropped, so it was unreachable; removing it loosens nothing. Three dependencies leave `package.json` and no third-party logger is introduced in exchange.

## Considered options

- **electron-log as proposed in #123**: automatic file transport in packaged apps, but rejected — JSON lines and low overhead on the scan hot path, and (as of the amendment) Effect already provides the structured-logging and tracing surface this log needs, so a second logging framework would be a second vocabulary for the same records.
- **`pino` (the original choice, 2026-09-29)**: superseded by the amendment. It worked; it also carried three dependencies for four trivial behaviours and a redaction list that could never fire behind the allowlist.
- **Separate files per context (`main.log`, `db-worker.log`, `sidecar.log`)**: avoids all append races, but rejected — one file is simpler to locate and attach when Copy diagnostics lands later.
- **Raw concurrent append to one file**: simplest wiring, but rejected — worker thread + child process appending across rotation risks interleaved/corrupt lines during long scans.

## Consequences

- **No logging dependency.** Three deps removed (`pino`, `pino-roll`, `pino-pretty`); the writer and the `Logger`/`Tracer` are ~110 lines of local code, pino-independent and Electron-free. Main owns destination, rotation, and quota.
- **A converted call site only files when the `Logger` reference is installed in the runtime running it.** `MainLive` and `WorkerLive` both install `OperationalLogLoggerLayer`; a `run*` that is its own composition root (the harness-snapshot store's probe fork) must install it too. This is the one new coupling the change introduces, and it is a real dependency, not a convention.
- **In an installed runtime, Effect's default console loggers are replaced**, so those logs land in the Operational file and nowhere else (no console duplication) — unchanged from the previous bridge, and now true in the main isolate as well as the worker.
- Worker/sidecar logging is forwarding-only by construction; log dir is injected (no `app.getPath` in worker, no stdout logging in sidecar). The sidecar's stderr JSON-line protocol is hand-framed now too, same fields.
- Minimal event allowlist only (boot, scan lifecycle + unparsed counts, IPC/MCP failures, harness lifecycle, tripwire); no per-file success chatter.
- Copy diagnostics bundle and backup/restore stay deferred (Top-10 #7 split).
