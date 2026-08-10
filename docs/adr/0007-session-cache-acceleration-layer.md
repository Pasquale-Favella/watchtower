# The session cache is an acceleration layer keyed by per-file fingerprints, with resume offsets and parse-version bumps

Status: accepted

`src/main/pipeline/session-cache.ts` is the acceleration layer between the raw on-disk tool stores and the ledger (the ledger is the durable truth; the cache is a fast re-parse path). Its decisions:

- **Per-file fingerprints** — a file is fingerprinted by `stat()` output (`dev`, `ino`, `mtimeMs`, `sizeBytes`), which lets `reconcileFile` classify a file as `unchanged` / `appended` (resume from the last complete line offset, guarded against truncate-then-regrow) / `modified` / `new`.
- **The append-only fast path** — for an appended JSONL, only the bytes past the resume offset are parsed and merged with the cached turns; the merged result is byte-for-byte identical to a full re-parse. A straddle guard detects a streamed message id restated across the boundary and abandons the shortcut on overlap (rare). On a studio machine where live agents constantly append to session JSONL, this is the dominant warm-run cost.
- **Parse-version bumps** — `PROVIDER_PARSE_VERSIONS` gives each provider a bump string: changing it forces a one-time re-parse when a parser's attribution logic changes. A version-suffixed cache file (`session-cache.v7.json`) keeps the format evolvable, with adoption of expired-source entries across bumps.
- **Cold-start robustness** — throttled partial cache saves after every ~50 files and a `complete` marker mean a killed run resumes from a warm cache; a cross-process hydration lock coordinates cold starts; durable providers (Copilot OTel) are never evicted so month-to-date totals survive.

**Why:** warm scans must be near-instant on machines with huge live histories. The fingerprint+offset design makes "port only what changed" real (ADR 0004) while staying byte-for-byte equivalent to a full re-parse — so the fast path can never produce different numbers than a clean rebuild.
