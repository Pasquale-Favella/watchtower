# Every section is a query-time payload built in the db-worker

Status: accepted

Each section's data payload and Session detail are derived at query time from the ledger under ADR 0002. [ADR 0023](./0023-db-worker-data-plane.md) places this work in the db-worker. Effect application queries in `src/main/application/` compose repository reads, pure `*-calculation.ts` functions, and outgoing Effect Schema validation under ADRs 0032 and 0034. Focused view, session, and export reads capture the required facts and current settings in one synchronous transaction. Scope filtering belongs to the query's SQL and calculation logic; some period/session semantics apply after reading rows. Derived results are not persisted or cached across requests.

Deliberate decisions embedded here:

- **The db-worker builds the payloads.** Main relays serializable, schema-validated results to the sandboxed renderer over IPC under ADR 0005. MCP query processes reuse application queries with their own read-only connection.
- **Zero-filled daily charts** — a contiguous calendar window, so days with no data are visible rather than silently missing.
- **The efficiency grade** is a weighted score (45% one-shot rate, 30% cache-hit fraction, 25% retry component) with a default when unmeasurable; retry tax and routing waste (against a cheapest-"reliable" baseline) are computed per model.
- **PR spend is turn-by-turn only** — legacy whole-session-split (`approx`) rows are dropped so every returned row carries honest attribution and costs are summable.
- **Models offers three lenses** — by-model (aliased), by-task, and an audit view keyed by the **raw** model identity exposing both the provider's recorded tokens and the normalized priced totals, so distinct models merged under a shared alias keep their token-source identity.
- **Compare is not pre-materialized** — all numbers recompute per the selected pair (a pair is user-selected), with a default of the top-two by cost.
- **Config is read live per query.** Repository reads include current aliases and price overrides, so a quick-add edit repaints the affected rows with no rescan.
- **Output validation.** Application queries validate their payloads with Effect Schema, and the renderer validates again on arrival. Request validation remains specific to each IPC or SDK boundary.

The raw-facts ledger keeps config changes instant. Pure query-time calculations receive explicit data and pricing inputs, so they can be tested independently of repository IO and renderer state.

## Request reuse

Queries reuse loaded facts/config within one request, preserving query-time derivation and live config. Caching derived results across requests would require an explicit amendment to this decision, bounded memory, revisions and measured benefit. Request reuse does not authorize persisting repriced scan facts or returning stale config-derived totals.
