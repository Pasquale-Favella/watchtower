# USD-anchored store; currency conversion only at the display/export boundary; the main process is the only network client

Status: accepted

Cost figures are stored **USD-anchored** in the ledger; the ledger is never rewritten in another currency. Conversion happens only at the display/export boundary via `convertCost`/`roundForActiveCurrency`/`formatCost` in `src/main/fx.ts` (deliberately unrounded until that boundary, so zero-fraction currencies like JPY/KRW/CLP aren't clamped early).

Exchange rates come from **Frankfurter** (ECB data, free, no API key) and the main process is the only thing that ever talks to it:

- Rates are fetched on the background-scan cadence, cached in the store's `currency_rate` side-table for 24 hours, and read back through IPC only.
- **The renderer never calls Frankfurter** — its only FX paths are `currency:get`/`currency:set`/`currency:list` and the `currency:changed` broadcast, which lands when a fresh rate arrives so money repaints without polling.
- Fetches are **fire-and-forget and never throw** — offline, blocked, malformed, or a stale rate silently keeps the last successfully cached rate, or USD (`rate: 1`) when nothing was ever cached. A stale rate beats no rate.
- Rates are **validated** — the code must be a real ISO-4217 member (a structural fallback tells a real currency from any three-letter string), and any fetched rate outside defensive bounds is refused as a parser bug or a tampered response.

**Why:** a telemetry dashboard must never show a wrong number because a network call failed or a rate was garbage, and it must never block the scan on the network. Main-only fetching keeps every network edge in one process, and USD anchoring keeps the store stable while the display currency is a free per-user preference.
