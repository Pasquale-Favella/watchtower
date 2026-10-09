# Every section is a query-time payload built in the main process

Status: accepted

Each of the eight sections — Overview, Sessions, Pull Requests, Spend, Optimize, Models, Compare, Settings, plus the Session detail — gets its payload from a dedicated builder (`overview.ts`, `sessions-view.ts`, `pull-requests-view.ts`, `spend-view.ts`, `models-view.ts`, `compare-view.ts`, `optimize-view.ts`, `yield-view.ts`) that re-derives everything at query time from the ledger through the aggregation seam (ADR 0002). There is no materialization and no per-query caching; the shared scope (period · provider · custom range) is applied at the SQL read and each payload is validated with its shared schema at the handler boundary.

Deliberate decisions embedded here:

- **The main process builds the payloads** so the sandboxed renderer only receives serializable, already-shaped rows over IPC (ADR 0005).
- **Zero-filled daily charts** — a contiguous calendar window, so days with no data are visible rather than silently missing.
- **The efficiency grade** is a weighted score (45% one-shot rate, 30% cache-hit fraction, 25% retry component) with a default when unmeasurable; retry tax and routing waste (against a cheapest-"reliable" baseline) are computed per model.
- **PR spend is turn-by-turn only** — legacy whole-session-split (`approx`) rows are dropped so every returned row carries honest attribution and costs are summable.
- **Models offers three lenses** — by-model (aliased), by-task, and an audit view keyed by the **raw** model identity exposing both the provider's recorded tokens and the normalized priced totals, so distinct models merged under a shared alias keep their token-source identity.
- **Compare is not pre-materialized** — all numbers recompute per the selected pair (a pair is user-selected), with a default of the top-two by cost.
- **Config is read live per query** — aliases and price overrides are assembled at the handler boundary, so a quick-add edit repaints the affected rows with no rescan.
- **Output-only validation** — request scopes are typed, not zod-validated; the validation boundary is deliberately the output payload.

**Why:** this is the payoff of the raw-facts ledger (ADR 0002). Building every section as a pure query-time derivation keeps the renderer sandboxed, keeps config changes instant, and lets each section's logic live in one testable main-process module.

## Clarifications for the Effect migration

ADR 0023 moved query-time payload construction into the db-worker; references above to main describe the original placement. ADR 0034 changes schema authority to Effect Schema incrementally, preserving the wire/tripwire boundary. The current implementation filters some scope semantics after reading rows, so the statement above that scope always applies in SQL describes the intended design rather than all current queries.

The target architecture first reuses a loaded set of facts/config within one request, preserving query-time derivation and live config. Caching derived results across requests remains a proposed extension requiring an explicit amendment to this decision, bounded memory, revisions and measured benefit. Request reuse does not authorize persisting repriced scan facts or returning stale config-derived totals.
