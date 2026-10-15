# Effect Schema is the contract authority during and after Zod replacement

Status: accepted as the migration target; implementation is incremental.

The owner authorized replacing Zod with Effect Schema, including synchronous Schema validation in the renderer, and reiterated that scope on 2026-09-30. Keeping separate Zod and Effect definitions for the same contract would create drift. We therefore migrate each contract and its consumers together, derive its TypeScript types from its authoritative schema, and remove Zod after the final consumers leave. This decision updates the Zod-specific restrictions in ADRs 0003, 0005 and 0032. It does not imply that all contracts have already migrated.

## Representation and boundaries

Provider extraction, stored row/cache codecs, decoded domain values, and IPC payloads are distinct representations. A transforming schema must name its decoded Type and encoded representation. Reuse field schemas where appropriate, but a snake_case/JSON-string row codec is not the validator for an already decoded camelCase IPC payload. Derive internal projections from reusable field definitions and keep a single authority for each distinct contract.

Backend Effect workflows decode with typed schema failures. Pure extraction and the renderer may decode synchronously through Result-based adapters. Renderer schemas have no IO, asynchronous decoding, service requirements, layers or runtime. React state and the Promise IPC facade continue to own UI behavior. Preserve the extraction skip-and-tally rule, the renderer result error state and event-dropping tripwire, and the channel/representation contract. Expected malformed JSON becomes a typed decode failure under the previously authorized correction; defects remain distinct.

Unknown-key stripping, finite numbers, coercion, defaults, null/optional values, Date behavior, mutable collection expectations and transforms require parity checks against the prior contract. The recorded rc.115 migration rules are inputs to that work, not proof of completion. Both decoded values and rejection verdicts matter. Preserve error labels/paths without serializing raw payloads or complete decode causes into the operational log.

Decoded values are reused inside an operation without repeated validation. Distinct trust boundaries still validate: a repository validates stored rows, an outgoing adapter validates its payload contract, and the renderer validates incoming unknown data. Schema replacement does not authorize dropping the tripwire to reduce round trips.

Related: [target architecture](../plans/effect-target-architecture.md), ADRs 0003, 0005, 0032 and issue #148.

## Third-party protocol schemas

The installed MCP SDK uses Zod internally and requires Zod shapes for high-level tool registration. Watchtower's own tool input schemas are part of this migration and need an evaluated SDK adapter before their shared contracts convert. Preserve the official SDK and derive advertised tool metadata from Effect contracts; SDK-owned protocol envelope validation may remain inside the dependency. Completion removes Watchtower-owned Zod contracts and imports, rather than asserting that every transitive dependency is Zod-free.
