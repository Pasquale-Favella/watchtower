# ADR 0020 — Ledger MCP on the official SDK over the shared aggregation seam

- Status: accepted
- Date: 2026-08-11
- Domain: agents (Coach & Skills surface), store (ledger, scope)
- Supersedes: ADR 0019's implementation choices (the hand-rolled JSON-RPC
  protocol layer and the hand-rolled SQL tool layer); the architecture
  (in-app self-serve ledger MCP server, per-conversation temp workspace)
  is unchanged.

## Context

ADR 0019 shipped the `watchtower-ledger` MCP server with a hand-rolled ~120-line
JSON-RPC subset and hand-rolled SQL queries in `tools.ts`. Two improvements:

1. The official `@modelcontextprotocol/sdk` (already a transitive dep of the
   ACP provider) implements the full protocol — initialize negotiation, error
   codes, ping, transport framing — so the hand-rolled core is replaced by
   `McpServer` + `StdioServerTransport`, added as a direct dependency.
2. The MCP tools' queries and typings duplicated what the UI already computes.
   The view builders (`buildOverviewFromLedger`, `buildSessionsViewFromLedger`,
   `buildModelsViewFromLedger`, `buildSkillsViewFromLedger`) and the shared
   zod schemas are the single source of truth; the MCP server should expose
   exactly those payloads, not a parallel shape.

## Decision

### 1. Protocol: official SDK

`protocol.ts` is deleted. `src/main/agents/ledger-mcp/server.ts` registers the
tools on an `McpServer` (factory shared by the entry and the in-memory tests);
`entry.ts` connects it to a `StdioServerTransport` and exits naturally when the
agent closes stdin. `@modelcontextprotocol/sdk@^1.30.0` is a direct dependency
(pure JS, CJS+ESM, resolves under `ELECTRON_RUN_AS_NODE` in dev and the
packaged asar; electron-builder ships production deps automatically).

Tool input schemas are passed as zod shapes directly to
`server.registerTool`, so the SDK's argument validation IS the shared zod
schema (e.g. `ledger_calls`'s `limit`/`model`/`project`/`category`/`tool`).

### 2. Queries + typings: the UI's own seam and payloads

`buildLedgerTools(store, scope)` now returns payloads that are byte-for-byte
the renderer's payload types — validated by the same zod schemas the renderer
parses over IPC:

| Tool | Payload |
|---|---|
| `ledger_scope` | baked `OverviewScope` + epoch range + in-scope counts |
| `ledger_overview` | `OverviewPayload` (`buildOverviewFromLedger`) |
| `ledger_sessions` | `SessionRow[]` (`buildSessionsViewFromLedger`) |
| `ledger_models` | `ModelsPayload` (`buildModelsViewFromLedger` + live alias/override config) |
| `ledger_skills` | `SkillsPayload` (`buildSkillsViewFromLedger` — the build-skill candidate pool) |
| `ledger_calls` | raw drill-down (the one custom shape the views don't offer), fed by the same `queryScope` seam with the UI's query-time display pricing |

`LedgerStore` gains a `readOnly` constructor option: the MCP process opens a
second connection with `{ readOnly: true }` and skips the DDL. The spawn env
now carries the `OverviewScope` verbatim (the entry validates it and computes
the range via `overviewDateRange`).

Fresh installs (no `ledger.db` yet — nothing scanned) inject no MCP server at
all: the composition root returns `null` when the DB file is absent, and the
runner serves the run without data tools. A read-only open of a missing file
would throw, and there is no data to serve anyway.

Scope semantics follow the UI: view tools use the seam's own range filtering
(session/turn-in-range), while the raw `ledger_calls` drill-down applies the
per-call range predicate explicitly (`queryScope` filters by provider only).

The Coach & Skills agent prompts are MCP-aware: a briefing in
`src/main/agents/prompts.ts` tells the harness it has read-only access to the
user's real usage data through the ledger tools, names the data window (the
same period/provider caption the UI shows), and grounds answers in the ledger
rather than guesses. The briefing is composed main-side into both the coach
prompt and the build-skill authoring prompt, and only when the server is
actually injected (fresh installs get no briefing) and only on a conversation's
first run (resumed turns already carry it in session context — restating it
would burn tokens). Build-skill keeps its evidence guardrails: the prompt
itself stays normalized-evidence-only, and the ledger is offered as a real
grounding source, never a license to fabricate.

## Consequences

- Protocol robustness (version negotiation, error codes, framing) is now the
  SDK's, maintained upstream; the entry is ~60 lines.
- The MCP contract cannot drift from the UI: a payload the renderer accepts is
  exactly what the agent receives, and the renderer's zod schemas are the
  MCP tool's argument + output contract. Cost semantics are the UI's
  query-time display pricing everywhere (superseding ADR 0019's base-cost note).
- The ledger-querying code lives in exactly one place (the seam + view
  builders); `tools.ts` is now pure composition.
- The MCP process pulls more of the main bundle (the seam + view builders),
  all of which is electron-free; the plain-node self-serve spawn is unchanged.
- The server now serves the FULL MCP primitive set: tools, resources
  (`ledger://scope` — the same `describeLedgerScope` the `ledger_scope` tool
  runs, `ledger://overview` — the UI Overview payload as JSON, `ledger://schema`
  — a self-documenting table/tool/primitive index) and prompts
  (`coach-orient` — the briefing + first-step nudge, `build-skill` — the
  authoring prompt whose args validate against the shared evidence schema,
  string-coerced on the MCP wire). All three surfaces reuse the same seam and
  the same main-side prompt builders, so no MCP surface can drift from the UI
  or from a `coach:run`. Resources and prompts ride the SDK natively — no
  hand-rolled protocol extension.
