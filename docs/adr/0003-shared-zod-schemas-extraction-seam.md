# Shared zod schemas are the single source of truth, with a loose extraction seam that degrades provider drift instead of failing the scan

Status: accepted

One set of zod schemas lives in `src/shared/schemas/` and is compiled into **both** the node and web bundles (`tsconfig.node.json` and `tsconfig.web.json` both include `src/shared/**/*`). The same schema objects validate every process-parity boundary: DB read-back, main→renderer payloads, renderer→main requests, and provider extraction. The DB→API snake→camel mapping also lives inside the schemas via `.transform()`, so the mapping is in the single source of truth rather than scattered across the store.

**The extraction seam.** Every provider's parsed call record flows through one loose schema (`parsedProviderCallSchema` in `providers.ts`) before it can become a cached call or a ledger row. The skip-and-report rule (`parseOrSkip` in `extract.ts`): unknown keys are stripped and never fatal; a **declared** field failing its type increments a per-provider `unparsed` tally, logs the context once, and returns `null` so the stream continues. The tally lands in scan metadata as per-provider `unparsed` counts and is surfaced in the UI (StatusBar) as the drift signal. A provider version bump degrades that provider's extraction — it never bricks the scan.

**Why:** the renderer, the ledger, and the providers are three different consumers of the same shapes; a duplicated schema set would drift silently. And foreign tool stores evolve without our control, so extraction must degrade gracefully and _visibly_: schema drift is a signal to show, not a crash to hide.

The renderer additionally re-validates each IPC payload on arrival (see ADR 0005) — the same schemas act as the wire contract's enforcement both ways.
