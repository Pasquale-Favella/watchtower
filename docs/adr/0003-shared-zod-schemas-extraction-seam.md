# Shared schemas are the contract authority, with extraction that tolerates provider drift

Status: accepted

One authoritative schema defines each extraction, persistence or wire contract and its TypeScript types. ADR 0034 authorizes replacing Zod with Effect Schema, including synchronous renderer validation. During migration, each contract retains its current definition until its schema and consumers convert together. Do not maintain two independent definitions for the same contract.

Portable schemas are compiled into both Node and web targets when their consumers require them. Persistence-only row codecs and internal projections may remain private to the backend. Stored snake_case keys and JSON strings, decoded domain values, and IPC payloads are distinct representations; their mappings belong to the corresponding codecs rather than to scattered store helpers. Share field definitions where their semantics agree.

**The extraction seam.** Every provider's parsed call record flows through one loose schema (`parsedProviderCallSchema` in `providers.ts`) before it can become a cached call or a ledger row. The skip-and-report rule (`parseOrSkip` in `extract.ts`): unknown keys are stripped and never fatal; a **declared** field failing its type increments a per-provider `unparsed` tally, logs the context once, and returns `null` so the stream continues. The tally lands in scan metadata as per-provider `unparsed` counts and is surfaced in the UI (StatusBar) as the drift signal. A provider version bump degrades that provider's extraction — it never bricks the scan.

**Why:** the renderer, the ledger, and the providers are three different consumers of the same shapes; a duplicated schema set would drift silently. And foreign tool stores evolve without our control, so extraction must degrade gracefully and _visibly_: schema drift is a signal to show, not a crash to hide.

The renderer additionally re-validates each IPC payload on arrival (see ADR 0005) — the same schemas act as the wire contract's enforcement both ways.
