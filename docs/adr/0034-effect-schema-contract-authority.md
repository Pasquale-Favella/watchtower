# Effect Schema is the contract authority

Status: accepted and implemented.

The owner authorized replacing Zod with Effect Schema, including synchronous Schema validation in the renderer, and reiterated that scope on 2026-09-30. The owned contract migration is complete. Twenty-two modules in the original 23-module baseline use Effect Schema; one UI-only module uses plain TypeScript types. Watchtower has no owned Zod contracts, imports, or direct dependency. Derive TypeScript types from each authoritative schema and keep one definition per contract. This decision replaces the Zod-specific guidance in ADRs 0003, 0005, 0030, 0031 and 0032.

## Representation and boundaries

Provider extraction, stored row/cache codecs, decoded domain values, and IPC payloads are distinct representations. A transforming schema must name its decoded Type and encoded representation. Reuse field schemas where appropriate, but a snake_case/JSON-string row codec is not the validator for an already decoded camelCase IPC payload. Derive internal projections from reusable field definitions and keep a single authority for each distinct contract.

Backend Effect workflows decode with typed schema failures. Pure extraction and the renderer may decode synchronously through Result-based adapters. Renderer schemas have no IO, asynchronous decoding, service requirements, layers or runtime. React state and the Promise IPC facade continue to own UI behavior. Preserve the extraction skip-and-tally rule, the renderer result error state and event-dropping tripwire, and the channel/representation contract. Expected malformed JSON becomes a typed decode failure under the previously authorized correction; defects remain distinct.

Preserve unknown-key stripping, finite numbers, coercion, defaults, null/optional values, Date behavior, mutable collection expectations and transforms when changing schemas. The rc.115 parity suites cover both decoded values and rejection verdicts. Preserve error labels/paths without serializing raw payloads or complete decode causes into the operational log. `tests/schema-authority.test.ts` guards against owned Zod imports and direct dependency declarations.

Decoded values are reused inside an operation without repeated validation. Distinct trust boundaries still validate: a repository validates stored rows, an outgoing adapter validates its payload contract, and the renderer validates incoming unknown data. Schema replacement does not authorize dropping the tripwire to reduce round trips.

Related: [target architecture](../plans/effect-target-architecture.md), ADRs 0003, 0005, 0032 and issue #148.

## Third-party protocol schemas

The installed MCP SDK uses Zod internally. Watchtower uses its `Server` request-handler API, with Effect Schema validating tool arguments and generating advertised JSON Schema. The adapter is implemented in `src/main/agents/ledger-mcp/server.ts`; see [ADR 0020](./0020-ledger-mcp-on-official-sdk-and-shared-seam.md#effect-argument-adapter-2026-10-02). The official SDK continues to own negotiation, protocol envelope validation, framing, and transports. Its internal Zod schemas remain inside the dependency and do not define Watchtower's contracts.
