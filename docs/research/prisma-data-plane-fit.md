# Research: Prisma data-plane fit — worker, transactions, MCP (map #82)

Question: can Prisma Client carry `LedgerStore` semantics on the db-worker thread?

## Verdict: FEASIBLE with raw-SQL escape hatches + a full async rewrite; two hard gaps

1. **Driver + worker_threads: gap, workaround exists.** Prisma 7 requires a driver adapter; local SQLite means `@prisma/adapter-better-sqlite3` + `better-sqlite3` — there is no `node:sqlite` connector (open feature request). better-sqlite3 documents worker-thread ownership (one db per worker), which fits the dedicated db-worker, but Electron + worker packaging bugs are reported and the worker stops being Electron-free. No logical bend; packaging cost only.
2. **Sync → async: fits at the wire, large blast radius inside.** Client is Promise-only. The `{ id, op, args }` protocol and frozen renderer contract survive, but `LedgerStore` (~30 methods), all dispatch arms, and every sync view/fx/export getter become async. The "no dispatch queue because sync atomic" assumption dies — a mutex/queue is needed so a long scan tx doesn't interleave `clear()`. Estimate: full `ledger.ts` rewrite + touching every caller; `protocol.ts` untouched.
3. **WAL/pragmas: gap, persistent-pragma workaround.** No first-class WAL flag; set `PRAGMA journal_mode=WAL` once via `$executeRawUnsafe`/migration/CLI — it persists across reopens. Single writer preserved.
4. **Transactions/idempotency: fit with raw SQL.** Interactive `$transaction` on SQLite is `IMMEDIATE`, matching `BEGIN IMMEDIATE`. But `createMany(skipDuplicates)` is unsupported on SQLite, so `INSERT OR IGNORE` idempotency on `UNIQUE(source_id, session_id, call_key)` must use `$executeRaw` INSERT OR IGNORE / ON CONFLICT DO NOTHING and count results for `PortResult.inserted`. Typed-only path bends the guarantee.
5. **Generated `call_key`: gap, keep-DDL workaround.** Generated columns unsupported: model `call_key` as `String? @default(dbgenerated())` + hand-written migration for `GENERATED ALWAYS AS (...) STORED` + `@@unique`. `migrate dev` fights the DEFAULT, so migrations stay hand-maintained. Computing the key in TS instead would bend the DB-enforced guarantee — not recommended.
6. **VACUUM/checkpoint/introspection: fit via sequenced raw.** `clear()` = tx(deleteMany x4), then outside the tx best-effort `VACUUM` + `wal_checkpoint(TRUNCATE)` as separate raw calls in try/catch. `sqlite_master` introspection via `$queryRaw`.
7. **Two connections + read-only MCP: partial gap.** WAL multi-process reads fit, but the adapter exposes only `{ url }` — no `readOnly` parity — and Prisma auto-creates a missing file, vs today read-only open throws. Keep the exists-gate (no MCP on fresh install) and never migrate from the MCP client.
8. **JSON/bools/BigInt: fit with care.** `Json` on SQLite GA since 6.2; TEXT payloads import cleanly; map INTEGER 0/1 → Boolean; keep dev/ino as text (Prisma throws on >2^53 ints, same as today).

Refs: Prisma SQLite/driver/transaction/raw-SQL docs, SQLite WAL/generated-column/VACUUM docs, better-sqlite3 threads doc, prisma issues (#29679 node:sqlite, #3303 WAL, #6336 generated columns, #23837 auto-create), ADR 0023/0020.
