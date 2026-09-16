# The ledger is an accumulating store of raw facts; every view is a query-time derivation

Status: accepted

`src/main/store/ledger.ts` is an append-only, normalized SQLite ledger of four fact tables — `ledger_source`, `ledger_call`, `ledger_turn`, `ledger_session` — holding only what the transcripts observed: per-call raw token counts plus the pipeline's `base_cost_usd` (never a repriced cost), per-turn classification, and per-source provenance. Rows are deduplicated by stable keys (`source_id`+`session_id`+`call_key`, generated from `dedup_key` or `turn_index`/`call_index`) and ported with `INSERT OR IGNORE` / atomic replace, so re-porting a file is idempotent and streaming re-emission can never double-count.

**Nothing is materialized.** Every view payload is re-derived at read time from flat rows through the aggregation seam (`src/main/store/aggregate.ts`): `price_override` and `model_alias` are pure config applied per-row on read — never written back into scan rows — so a config change (an alias, a price override, a currency) repaints every view with no rescan. The config tables (`model_alias`, `price_override`, `currency_rate`, cadence, display currency, local MCP startup) are deliberately not scan data and survive a full data wipe. Classification and cost are computed once at port-in through `cachedTurnToClassified`, never recomputed on every read.

**Why:** raw facts with query-time derivation is the only shape that makes "the ledger absorbs the whole local history, sub-second reads, and instant config repaints" simultaneously true. A scan-time materialization would freeze derived numbers until the next scan and force rescans on config edits.

Consequences: the `ProjectSummary[]` report shape was removed from the scan path entirely — the scan returns metadata only, and `ProjectSummary` survives solely as a query-time shell for the Optimize/Yield and export paths.
