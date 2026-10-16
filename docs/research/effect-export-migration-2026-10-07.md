# Export migration to Effect, 2026-10-07

Source is `7387a617f848b72fc918cb7710e88ebdafaf780b`.

`d36dea5` adds LedgerExportReads over the existing repository and native SQL client. Five transactional SELECTs capture sufficient facts and current pricing configuration. Effect Schema decodes the rows after commit. No new runtime or connection is added.

`d946249` routes CSV and JSON exports through that port and pure TypeScript calculations. The application no longer reconstructs legacy call, turn, session and project summary graphs. Empty exports return before currency or file access; nonempty requests capture currency once. SQL and Schema failures remain typed, and expected file errors keep bounded guidance.

Nine export tables, CSV quoting, JSON metadata, pricing diagnostics, whole-turn admission, duplicate-ID ordering and USD/JPY output parity retain regression coverage. Compatibility serializers remain until their callers migrate.

## Verification

Node/web and strict test typechecks, formatting, build and lint passed. The final focused suite passed 163 tests across 13 files. Full units passed 185 files with 2,448 tests and two skips. All four local Electron checks passed. Fresh Windows directory packaging and actual packaged IPC/MCP checks passed. Installer and macOS/Linux packaged acceptance remain open. These results precede the documentation cleanup; no new code tests were run for that cleanup.

Both renderer stores retain the Git content from ce81593, without request IDs, promise ownership or applyChange coalescing.

## Remaining migration work

Complete provider IO and cancellation, remove compatibility callers and duplicated serializers, finish Overview's application/calculation boundary, and separate worker responsibilities. The user stopped profiling work and requested removal of the profiling JSON files from docs. No further profiling work is planned.
