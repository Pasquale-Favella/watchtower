# Research: Prisma Electron packaging fit (map #82)

Question: does Prisma + SQLite fit this Electron app's packaging and runtime?

## Verdict: FIT — only with Rust-free engine

Use Prisma ≥6.16 GA / v7 default: `provider="prisma-client"`, `engineType="client"` (no `binaryTargets`) + driver adapter `@prisma/adapter-better-sqlite3`. Query compilation is TS+WASM, no `query-engine.*.node`/`.exe` sidecar. Legacy `prisma-client-js` library/binary BREAKS the current setup (unpack + `extraResources` engines, `Cannot find module '.prisma/client/default'`, spawn ENOENT from asar).

Per target:

- **Win NSIS: fit.** WASM+JS runs inside asar; only `better-sqlite3/*.node` needs `asarUnpack: **/*.node`.
- **macOS universal DMG/zip: fit with client engine; breaks with legacy.** Legacy needs both `darwin` + `darwin-arm64` engines (~60–70MB doubled) and conflicts with the existing `x64ArchFiles` minimatch rule. Client engine is arch-neutral WASM.
- **Linux AppImage/deb: fit.** Client engine eliminates the dual `debian-openssl` engine problem; only the better-sqlite3 prebuild remains.

## Config required

- `generator client { provider = "prisma-client" engineType = "client" }` + `PrismaBetterSqlite3({ url: "file:<userData>/ledger.db" })`.
- `electron-builder.yml`: keep `files: out/**`, add generated client + WASM to `files` (not `extraResources`); `asarUnpack: **/*.node`. Do not use legacy engine path shims (unsupported in v7).
- Generate BEFORE `electron-vite build`: `prisma generate && electron-vite build && electron-builder`. One generate suffices (WASM portable); CI runs it per runner before build. Never generate on first boot.
- DB stays at `app.getPath('userData')`, never in asar (WAL needs sidecars + write for VACUUM). Re-apply `PRAGMA journal_mode=WAL` via raw query through the adapter.

## Size cost

Legacy: +60–70MB/platform (~2x for universal/dual-openssl). Client engine: roughly +3–10MB (WASM compiler + better-sqlite3) vs current 0MB `node:sqlite`.

## Open risks

1. Sync-atomicity lost: Prisma is async; scan vs read serialization + clear-mid-scan self-heal need redesign.
2. Reintroduces a native dep (`better-sqlite3`) vs zero-dep `node:sqlite`; rebuild/sign per platform.
3. No `node:sqlite` adapter — must adopt better-sqlite3/libSQL.
4. `Bytes`/`BigInt` not IPC-serializable at the worker→renderer boundary.
5. `VACUUM` / `wal_checkpoint` via raw SQL + pool semantics unverified; mac hardened-runtime/WASM entitlement check needed.
6. `migrate deploy` still forks the Rust schema engine — decide client-only DDL vs full migrations.

Refs: Prisma docs (no-Rust engine, SQLite support, database drivers, v7 upgrade, engines), `electron.build` contents docs, electron-vite distribution guide, prisma/prisma discussions/5200 and issues/9613.
