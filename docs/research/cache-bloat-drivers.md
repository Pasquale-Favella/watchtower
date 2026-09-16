# Cache bloat drivers — per-file serialization findings

Research for "Quantify per-file bloat drivers in the cache dir" (part of the
"Pricing cache 333 MB diagnosis map"). Diagnosis only — no fix proposed.
All counts measured with `python3 -c` against the tree; no estimates.

## What the pane totals

- Settings › Privacy & data "Pricing cache" is `dirSize(cacheDir)` over the
  whole cache dir, not `litellm-pricing.json` alone:
  `src/main/db-worker/context.ts:41-53` (`dirSize`, recursive, every file
  counts) wired as `cacheSize: dirSize(this.cacheDir)` in
  `src/main/db-worker/context.ts:204-215` (`userDataPaths`).
- Effective cache dir is `join(dataDir, 'cache')`
  (`src/main/index.ts:329`), published to the pipeline as
  `WATCHTOWER_CACHE_DIR` (`src/main/db-worker/entry.ts:26`).

## Files that can land in the counted dir

| File | Writer | Envelope |
|---|---|---|
| `session-cache.v7.json` (+ priors `v6`/`v5`, legacy `session-cache.json`) | `src/main/pipeline/session-cache.ts:42-54` | `{version, providers:{provider:{envFingerprint, files:{path:CachedFile}, durable?, prEvidenceV1?}}}` |
| `codex-results.json` | `src/main/pipeline/codex-cache.ts:20` | `{version:8, files:{path:{mtimeMs,sizeBytes,project,calls:ParsedProviderCall[]}}}` (`codex-cache.ts:19-34`) |
| `cursor-results.json` | `src/main/pipeline/cursor-cache.ts:32` | `{version:6, dbMtimeMs, dbSizeBytes, lookbackFloor, calls:ParsedProviderCall[]}` (`cursor-cache.ts:24-30`) |
| `antigravity-results.json` | `src/main/pipeline/providers/antigravity.ts:182-184` | `{version:5, cascades:{id:{mtimeMs,sizeBytes,calls:ParsedProviderCall[]}}}` (`antigravity.ts:51`, `134-143`) |
| `antigravity-statusline.jsonl` | `src/main/pipeline/providers/antigravity.ts:186-188` | append-only JSONL, one event per line (`antigravity.ts:1007-1020`) |
| `litellm-pricing.json` | `src/main/pipeline/models.ts:176-178` | `{timestamp, data:{model:ModelCosts}}` (`models.ts:227-230`) |
| `hydrating.lock`, `session-refresh.lock` (+`.takeover`) | `src/main/pipeline/session-cache.ts:622`, `src/main/pipeline/cache-refresh-lock.ts:7-8` | tiny lock records, still counted by `dirSize` |
| `session-cache.v7.json.<rand>.tmp` etc. | `src/main/pipeline/session-cache.ts:428-466`, `codex-cache.ts:137-138`, `cursor-cache.ts:106`, `antigravity.ts:361` | transient atomic-write temps; session-cache temps older than 5 min are swept (`session-cache.ts:588-610`) |

Path quirk (measured by reading the source): `cursor-cache.ts:34-36`
`getCacheDir()` ignores `WATCHTOWER_CACHE_DIR` and always uses
`join(homedir(), '.cache', 'watchtower')`, while session/codex/antigravity/
models all honor the env override (`session-cache.ts:120-122`,
`codex-cache.ts:36-38`, `antigravity.ts:178-180`, `models.ts:171-174`).
On default paths they coincide; under a custom `dataDir` the cursor file
lands outside the counted dir.

## Per-entry field counts (schema shapes)

Measured from `src/shared/schemas/session-cache.ts` and
`src/main/pipeline/providers/types.ts`:

- `CachedUsage`: 8 counts, always present (writes default missing to 0 —
  `session-cache.ts:4-5` comment): `inputTokens, outputTokens,
  cacheCreationInputTokens, cacheReadInputTokens, cachedInputTokens,
  reasoningTokens, webSearchRequests, cacheCreationOneHourTokens`.
- `CachedCall` (`cachedCallSchema`, `session-cache.ts:22-45`): 22 fields
  (`provider, model, usage{8}, costUSD?, isEstimated?, speed, timestamp,
  tools[], bashCommands[], skills[], subagentTypes?, deduplicationKey,
  project?, projectPath?, workingDirectory?, toolSequence?,
  locAdded?, locRemoved?, interrupted?, userModified?, toolErrors?,
  editFailed?`).
- `CachedTurn` (`session-cache.ts:48-56`): 7 fields (`timestamp, sessionId,
  userMessage, calls[], gitBranch?, prRefs?, spawnToolUseIds?`).
- `CachedFile` (`session-cache.ts:70-86`): 15 fields (`fingerprint{4},
  lastCompleteLineOffset?, canonicalCwd?, workingDirectory?,
  canonicalProjectName?, mcpInventory[], turns[], agentType?, failed?,
  title?, prLinks?, isSidechain?, parentSessionId?, agentSpawnLinks?,
  ambiguousSpawnAgentIds?`).
- `ProviderSection` (`session-cache.ts:89-99`): 5 slots (`envFingerprint,
  files{}, durable?, prEvidenceV1?` + comment slot).
- `FileFingerprint` (`session-cache.ts:62-67`): 4 numbers
  (`dev, ino, mtimeMs, sizeBytes`).
- `ParsedProviderCall` (`providers/types.ts:23-62`, the shape stored in the
  three pre-caches): 28 fields — flat token block (9 incl. `costUSD`),
  `costIsEstimated?`, `tools[], bashCommands[], subagentTypes?, skills?`,
  `timestamp, speed, deduplicationKey`, `locAdded?, locRemoved?,
  editFailed?, turnId?, toolSequence?`, `userMessage, sessionId, project?,
  projectPath?, workingDirectory?`.

## Serialization verbosity (measured byte costs)

- Empty `CachedUsage` serializes to 198 bytes; 142 of those are key names
  (72% key overhead). A minimal call skeleton (provider/model/usage/speed/
  timestamp/empty arrays/dedup key/empty strings) is 436 bytes; a minimal
  turn wrapping one minimal call is 449 bytes. An empty `userMessage:""`
  still costs 19 chars of JSON per occurrence.
- Every cache persists via whole-file `JSON.stringify` + atomic tmp/rename —
  no delta/incremental writes: session-cache (`session-cache.ts:431`),
  codex (`codex-cache.ts:138`), cursor (`cursor-cache.ts:108`),
  antigravity (`antigravity.ts:364`), pricing (`models.ts:227`).
- `ModelCosts` (`models.ts:8-15`) carries 6 long keys per model
  (`inputCostPerToken, outputCostPerToken, cacheWriteCostPerToken,
  cacheReadCostPerToken, webSearchCostPerRequest, fastMultiplier`): 115 key
  chars; one expanded costs object is 176 bytes JSON, ~133 chars (~76%) key
  overhead. The bundled snapshot's compact tuple form for the same rates is
  30 bytes — expanded is ~5.87x larger per entry.

## Bundled snapshot baseline (measured)

`src/main/pipeline/data/litellm-snapshot.json`: 4034 entries / 266459 bytes
(~266 KB). Avg key length 31.0 chars, longest 76. 2930 keys contain `/`;
tuple lengths are `{4, 5}` with 4029 five-element entries.
`src/main/pipeline/data/pricing-fallback.json`: 190 entries / 11022 bytes.

## Stripped-name duplication in `fetchAndCachePricing` (measured)

`src/main/pipeline/models.ts:218-223` indexes every `provider/model` key
again under its stripped bare name (first-wins). Simulated against the
bundled snapshot key set:

- 612 stripped names would be newly added keys (distinct stripped targets
  not already present as bare keys).
- 2311 slash keys collide with an existing bare key (dropped by the
  first-wins guard — no extra entry, but the guard is what decides).
- 2354 distinct stripped targets total; 1742 already exist as bare keys.
- Simulated expanded final key count from snapshot-shaped data:
  4034 + 612 = 4646 keys; at 176 bytes per expanded `ModelCosts` object that
  is ~817696 bytes of entry payload vs the 266459-byte compact snapshot —
  the expansion + duplication factor, not the model count, sets the floor
  for `litellm-pricing.json`.

## Duplicate stores of the same turns

- Codex: `codex.ts:380` serves `readCachedCodexResults`, and the parser
  flushes via `parser.ts:3270` (`flushCodexCache`) — the same calls then
  persist again inside `session-cache.v7.json` turns via the warm
  reconcile/save path (`parser.ts:3920-3961`, `session-cache.ts:424-431`).
  Per-file entries repeat `project` + full `ParsedProviderCall` (28 fields)
  per call (`codex-cache.ts:24-29`).
- Cursor: `cursor.ts:1019-1050` read/write the whole call array as one blob;
  any DB mtime/size change invalidates the entire blob and rewrites it, and
  the same calls persist again in the session cache.
- Antigravity triple-store for statusline-sourced calls: the append-only
  `antigravity-statusline.jsonl` (never truncated — no `truncate` in
  `antigravity.ts`, single `appendFile` at `1015`), plus the parsed
  `cascades[].calls` in `antigravity-results.json`, plus the session-cache
  turns. RPC/SQLite-sourced calls are double-stored (results.json +
  session-cache). `shouldReparseAntigravitySource` forces reparse of the
  statusline path on every pass (`antigravity.ts:1151-1154`).
- Cross-version accumulation: `CACHE_VERSION = 7`
  (`session-cache.ts:42`) with `PRIOR_CACHE_VERSIONS = [6, 5]`
  (`session-cache.ts:312`) plus the adopt-copy legacy file
  (`session-cache.ts:412-422`) means up to four full session-cache
  snapshots (v5 + v6 + v7 + legacy) can coexist in the counted dir; each
  prior only contributes expired-source PR orphans on adoption
  (`session-cache.ts:328-386`), but stale files are never deleted by the
  app. Codex v8 (`codex-cache.ts:19`), cursor v6 (`cursor-cache.ts:22`),
  antigravity v5 (`antigravity.ts:51`) each invalidate by version bump,
  which re-parses and rewrites the whole file once.

## Pricing-cache write/read behavior (for the map's growth-rule tickets)

- `fetchAndCachePricing` rewrites the whole `litellm-pricing.json` on every
  successful fetch (`models.ts:226-230`); `loadCachedPricing`
  (`models.ts:235-244`) treats it as fresh until `getPricingCacheTtlMs()`
  elapses, which returns `Infinity` unless `WATCHTOWER_PRICING_TTL_HOURS > 0`
  is set (`models.ts:48-54`) — i.e. by default the file never expires by age.
- Codex flush evicts entries for deleted source files (`codex-cache.ts:124-132`);
  antigravity flush evicts dead cascades only when `liveCascadeIds` is passed
  (`antigravity.ts:340-355`, wired at `parser.ts:3273`); cursor has no
  per-entry eviction (single blob); session-cache orphans survive per the
  durable-provider set (`session-cache.ts:78`) and PR-orphan adoption above.

## ADR / glossary fit

- ADR 0007 (session-cache acceleration layer): findings describe the layer's
  on-disk cost only; no flow change implied.
- ADR 0010 (pricing overrides) / ADR 0002 (ledger aggregation): pricing
  `Alias` and `Price override` (CONTEXT.md glossary) are query-time and do
  not add cache-dir files — confirmed no new writer found for them.
- No ADR conflict introduced (research only, no behavior change).
