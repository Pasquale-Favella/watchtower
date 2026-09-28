# Pricing: bundled snapshot with fallbacks, query-time overrides, honest unpriced rows, and estimated tokens

Status: accepted

Model pricing is resolved in `src/main/pipeline/models.ts` from a **precedence chain**: user price override → user model alias → bundled `litellm-snapshot.json` → live LiteLLM fetch (bounded; on timeout falls back to the snapshot) → gap-fill `pricing-fallback.json` (last resort). A snapshot ships in the repo and hardcoded built-in overrides/aliases cover known gaps (Cursor house models, auto-model names, reasoning-suffix variants). Unknown models price to `$0` — never to a wrong number.

- **Overrides apply at query time.** User aliases and price overrides are config (ADR 0002), never written back into scan rows — so the Models quick-add (type an alias or a price) repaints affected rows with no rescan, and a config change invalidates only the daily cache.
- **Unpriced rows are shown honestly.** A row with `costUSD === 0 && savingsUSD === 0` is _unpriced_ (nothing billed and nothing avoided), rendered dimmed with em dashes for tokens and cost — not silently presented as free. Expected-free models (local-looking models, savings-mapped models, exact zero-rate overrides) are excluded from the "unpriced" signal, and pricing coverage reports the share of calls priced from real data.
- **Estimated tokens are marked.** Providers whose telemetry lacks usage counts fall back to a flat 1 token ≈ 4 chars heuristic (`estimateTokensFromChars`), and the resulting costs carry an `isEstimated` flag surfaced as estimated cost — "provider-reported usage × price" and "character-estimated usage × price" are never silently mixed.
- **Cost clamping** — negative/NaN token counts clamp to 0, and per-token rates are clamped to `[0, 1]` as defense-in-depth.

**Why:** the pricing data is a moving target (new models weekly), so it must degrade gracefully from user intent → shipped snapshot → live fetch → fallback, and it must never fabricate a plausible-looking number for a model it doesn't know — a dimmed `—` invites a quick-add alias; a wrong `$X` hides real spend.
