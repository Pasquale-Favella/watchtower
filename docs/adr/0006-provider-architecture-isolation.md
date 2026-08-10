# Provider architecture: one file per tool, an isolated contract, lazy loading

Status: accepted

Each of the 38 supported tools lives in a single file under `src/main/pipeline/providers/` and follows a common `Provider` contract: discovery of on-disk sources, a session parser, and per-provider quirks. Discovery goes through `safeDiscoverSessions`, which isolates each provider — a provider that throws during discovery is skipped with a one-line warning and returns `[]`; it can never take down the rest of the scan.

Heavy or platform-specific providers (Antigravity, Forge, Goose, Cursor, OpenCode, Cursor Agent, Crush, Warp, Vercel AI Gateway, ZCode, Zed) are lazy-loaded behind `loadX()` guards and never block a scan when their module can't load.

**Per-file isolation is the invariant.** A failure parsing one file writes a negative-result marker keyed to that file's fingerprint (so it isn't re-thrown every run, and re-parses only if the file changes) instead of aborting; a file that fails to port into the ledger is warned and swallowed so it simply stays absent and is retried on a later scan — the ledger is its own resume marker. SQLite-busy and permission errors skip the whole provider rather than abort. Cross-provider dedup uses a shared `seenKeys` set so one call observed by two providers is never ported twice.

**Why:** the app reads dozens of third-party, uncontrolled, rapidly-changing data formats on real machines. Any provider's file layout or telemetry can change, be corrupt, or be unreadable at any time — so a provider must be an isolated, replaceable unit whose failure degrades only itself.
