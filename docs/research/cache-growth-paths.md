# Cache growth paths audit (research for Pricing cache 333 MB diagnosis map)

Scope: every file counted by the Settings pane total. The `Pricing cache` row is
`dirSize(cacheDir)` (`src/main/db-worker/context.ts:41-53,204-215`), not
`litellm-pricing.json` alone. The scan ports lifetime history
(`src/main/db-worker/context.ts:63-65`), so the active session cache mirrors the
full source corpus by design. Verdict below per file: steady-state history vs
runaway growth, plus misuse flags. No eviction or relabeling proposed here.

## Files in the cache dir and their growth rules

### `session-cache.v7.json` (active) — steady-state, bounded by source corpus
- Single active file, version-suffixed (`src/main/pipeline/session-cache.ts:42-49,124-126`).
- Warm runs serve `unchanged` entries without parsing; appended JSONL resumes from
  `lastCompleteLineOffset` via `reconcileFile`
  (`src/main/pipeline/session-cache.ts:536-567`; fast path
  `src/main/pipeline/parser.ts:2189-2299` with straddle guard falling back to full
  re-parse). Dedup merge keeps appends identical to a full re-parse
  (`src/main/pipeline/session-cache.ts:574-584`).
- Non-durable providers evict orphans (missing sources deleted):
  Claude (`src/main/pipeline/parser.ts:2353-2362`) and generic providers
  (`src/main/pipeline/parser.ts:3284-3291`), except PR-bearing orphans kept for
  attributable PR spend (`src/main/pipeline/parser.ts:2150-2163,2356-2358`).
- Durable providers (Copilot OTel, `DURABLE_PROVIDER_NAMES`
  `src/main/pipeline/session-cache.ts:76-78`) never evict on missing sources:
  union-by-`deduplicationKey` merge (`src/main/pipeline/parser.ts:3219-3236`),
  orphan re-emission (`src/main/pipeline/parser.ts:3310-3318`), fingerprint-change
  carry-forward of missing-source entries
  (`src/main/pipeline/parser.ts:2916-2935`). Bounded by a 90-day newest-call
  age-out (`src/main/pipeline/parser.ts:3293-3308`).
- `PROVIDER_PARSE_VERSIONS` bumps (`src/main/pipeline/session-cache.ts:86-116`,
  fingerprinted in `computeEnvFingerprint`
  `src/main/pipeline/session-cache.ts:139-145`) and the one-shot `prEvidenceV1`
  re-parse (`src/main/pipeline/session-cache.ts:168-170`,
  `src/main/pipeline/parser.ts:3320-3325`) cost one full re-parse (CPU), not size
  growth: same entries rewritten under the same keys.
- Throttled partial saves (`src/main/pipeline/parser.ts:3054,4000-4011`) and the
  `complete` marker (`src/main/pipeline/session-cache.ts:153-158`,
  `src/main/pipeline/parser.ts:4073-4089`) affect write frequency / cold-resume,
  not size. Verdict: grows with live history — steady-state, not runaway.

### Prior `session-cache.v*.json` + legacy `session-cache.json` — stepwise unbounded (MISUSE 1)
- Each `CACHE_VERSION` bump mints a fresh filename
  (`src/main/pipeline/session-cache.ts:44-49`); `PRIOR_CACHE_VERSIONS = [6, 5]`
  (`src/main/pipeline/session-cache.ts:312-316`).
- `adoptPriorCache` / `adoptNewestPriorCache`
  (`src/main/pipeline/session-cache.ts:336-386`) READ prior files but nothing ever
  deletes them (no `unlink` of prior versioned files anywhere in the codebase);
  the legacy file is "never written or deleted any more"
  (`src/main/pipeline/session-cache.ts:50-53,412-422`).
- Every shipped bump therefore leaves one more dead multi-MB file behind, and ALL
  of them are counted in the pane total via `dirSize`. Dead versioned files in the
  total is misuse.

### `codex-results.json` — bounded, overwrite per path + missing-file eviction
- Per-source entries keyed by path, overwritten on write
  (`src/main/pipeline/codex-cache.ts:104-119`); `flushCodexCache` evicts entries
  whose files no longer exist (`src/main/pipeline/codex-cache.ts:121-132`).
- Version gate (`CODEX_CACHE_VERSION = 8`,
  `src/main/pipeline/codex-cache.ts:19,46-58`) drops everything on bump (one cold
  re-parse, then steady). Verdict: tracks live Codex sources — steady-state.

### `cursor-results.json` — bounded single-entry overwrite
- Whole-file overwrite per write, valid only for the exact DB fingerprint +
  lookback floor (`src/main/pipeline/cursor-cache.ts:51-113`); version gate
  (`CURSOR_CACHE_VERSION = 6`, `src/main/pipeline/cursor-cache.ts:22,62-71`)
  invalidates wholesale. Never accumulates per-source. Verdict: bounded (~one DB parse).
- Quirk: its `getCacheDir` ignores `WATCHTOWER_CACHE_DIR`
  (`src/main/pipeline/cursor-cache.ts:34-36`, cf. env-aware dirs in
  `session-cache.ts:120-122`, `codex-cache.ts:36-38`, `models.ts:171-174`,
  `providers/antigravity.ts:178-180`), so under a custom cache dir it lands
  outside the pane total.

### `antigravity-results.json` — bounded, overwrite per cascade + live-set eviction
- Entries keyed by cascade id, overwritten on snapshot/parse
  (`src/main/pipeline/providers/antigravity.ts:1329-1334,1382-1387,1176-1200`).
- `flushCache(liveCascadeIds)` evicts cascades not in the live set
  (`src/main/pipeline/providers/antigravity.ts:340-354,1441-1443`, called with live
  ids `src/main/pipeline/parser.ts:3271-3274`); version gate resets
  (`src/main/pipeline/providers/antigravity.ts:326-338`). Eviction only runs when
  the flush path executes, but keys are still per-live-cascade overwrites.
  Verdict: tracks live cascades — steady-state.

### `antigravity-statusline.jsonl` — genuinely unbounded (MISUSE 2)
- Append-only: opened `'a'`, one line per status-line event
  (`src/main/pipeline/providers/antigravity.ts:1007-1020`), with no truncation,
  rotation, or eviction anywhere. Grows forever with usage.

### `litellm-pricing.json` — bounded overwrite snapshot; growth driver is upstream
- `writeFile` overwrites the whole file per refresh
  (`src/main/pipeline/models.ts:205-233`); each fetch builds a fresh `Map`, so no
  in-file accumulation. Stale reads return null
  (`src/main/pipeline/models.ts:235-244`).
- Default TTL is `Infinity` (`getPricingCacheTtlMs`,
  `src/main/pipeline/models.ts:48-54`): static between refreshes; refresh only via
  `--refresh-pricing` (`refreshPricingNow`, `src/main/pipeline/models.ts:61-65`,
  wired `src/main/db-worker/context.ts:504-511`) or `WATCHTOWER_PRICING_TTL_HOURS>0`.
- Size tracks the upstream LiteLLM JSON (model count) plus stripped-prefix
  duplicate keys (`name` + `stripped`, `src/main/pipeline/models.ts:215-224`,
  ~2x entries). External steady growth, not a local leak; overwrite semantics.

### Locks / temps — bounded, negligible
- `session-refresh.lock` + `.takeover`
  (`src/main/pipeline/cache-refresh-lock.ts:7-8`), `hydrating.lock`
  (`src/main/pipeline/session-cache.ts:622-634`), `*.tmp` atomic-write temps with
  orphan cleanup for the current version prefix
  (`src/main/pipeline/session-cache.ts:588-610`). Tiny by construction.

## Cross-cache duplication (MISUSE 3)
- Codex/Cursor/Antigravity spend is stored twice: once in its pre-cache
  (`codex-results.json`, `cursor-results.json`, `antigravity-results.json`) and
  again as turns inside `session-cache.v*.json` (the pre-cache exists so the
  session cache can serve without invoking the provider parser —
  `src/main/pipeline/session-cache.ts:94-100`). Both copies count toward the pane
  total. By design for speed, but it inflates the 333 MB reading.

## Daily-backfill references — no cache-dir growth path
- `parser.ts:2331,3258,3902,4076` and `content-utils.ts:8` refer to the ledger-side
  daily trend backfill (a crash in one record must not wipe history, issue #441),
  gated on the `complete` marker. There is no `daily-cache.*` file in the cache
  dir; `cache-refresh-lock.ts:141-143` only reserves daily→session lock ordering
  for a follow-up that has not landed.

## Bottom line
- 333 MB is mostly steady-state history (lifetime scan + turn-payload verbosity),
  inflated by countable misuse: dead `session-cache.v*.json` files in the total,
  double-stored Codex/Cursor/Antigravity calls, and one truly unbounded file
  (`antigravity-statusline.jsonl`, append-only with no rotation).
