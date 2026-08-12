# ADR 0020 — Ledger MCP on the official SDK over the shared aggregation seam

- Status: accepted
- Date: 2026-08-12
- Domain: agents (Coach & Skills surface), store (ledger, scope)
- Supersedes: ADR 0019's implementation choices (the hand-rolled JSON-RPC
  protocol layer and the hand-rolled SQL tool layer) AND the scope-baked
  spawn semantics (2026-08-12: the server now serves the full lifetime
  ledger; per-window filtering rides the tools' optional `scope` argument).
  The architecture (in-app self-serve ledger MCP server, per-conversation
  temp workspace) is unchanged.

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

`buildLedgerTools(store)` now returns payloads that are byte-for-byte the
renderer's payload types — validated by the same zod schemas the renderer
parses over IPC:

| Tool | Payload |
|---|---|
| `ledger_scope` | the window of a query (`OverviewScope`, from the optional `scope` arg) + epoch range + in-window counts |
| `ledger_overview` | `OverviewPayload` (`buildOverviewFromLedger`) |
| `ledger_sessions` | `SessionRow[]` (`buildSessionsViewFromLedger`) |
| `ledger_models` | `ModelsPayload` (`buildModelsViewFromLedger` + live alias/override config) |
| `ledger_skills` | `SkillsPayload` (`buildSkillsViewFromLedger` — the suggested-skill pool the chat's craft chips surface) |
| `ledger_calls` | raw drill-down (the one custom shape the views don't offer), fed by the same `queryScope` seam with the UI's query-time display pricing |

### Lifetime-serving: the harness filters autonomously (2026-08-12)

The server serves the FULL lifetime ledger — nothing is baked at spawn. The
spawn context (`WATCHTOWER_LEDGER_MCP`) carries only `dbPath`, and the runner
builds the server config with no scope. Every tool accepts an optional
`scope` argument typed by the shared `overviewScopeSchema` (period / provider
/ custom range) and computes its payload for exactly that window; omitted, it
defaults to `{ period: 'lifetime' }`. The harness therefore consumes the data
and filters autonomously — one server instance answers any window the agent
asks about, instead of one server per conversation baked to the UI's current
scope. The UI's current window is not lost: it rides the first-run briefing
as a *suggested default* ("the user is currently viewing …"), phrased
explicitly as a hint the agent is free to ignore.

`LedgerStore` gains a `readOnly` constructor option: the MCP process opens a
second connection with `{ readOnly: true }` and skips the DDL.

Fresh installs (no `ledger.db` yet — nothing scanned) inject no MCP server at
all: the composition root returns `null` when the DB file is absent, and the
runner serves the run without data tools. A read-only open of a missing file
would throw, and there is no data to serve anyway.

Scope semantics follow the UI within a tool call: view tools use the seam's
own range filtering (session/turn-in-range), while the raw `ledger_calls`
drill-down applies the per-call range predicate explicitly (`queryScope`
filters by provider only).

The Coach & Skills agent prompts are MCP-aware: a briefing in
`src/main/agents/prompts.ts` tells the harness it has read-only access to the
user's FULL usage history through the ledger tools, explains that each tool
accepts an optional `scope` argument to filter to a window (default lifetime),
names the user's current window as a suggested default (the same
period/provider caption the UI shows), and grounds answers in the ledger
rather than guesses. The briefing is the ONE role definition for the single
agent — coaching AND skill authoring (ADR 0021) — composed main-side into the
coach prompt, and only when the server is actually injected (fresh installs
get no briefing) and only on a conversation's first run (resumed turns already
carry it in session context — restating it would burn tokens). The
skill-authoring scope of the same briefing tells the agent to return ONLY
markdown in the canonical `# ` / `## Description` / `## When to use` /
`## Example` shape, grounded via `ledger_skills`/`ledger_calls` — the ledger
is a real grounding source, never a license to fabricate.

## Consequences

- Protocol robustness (version negotiation, error codes, framing) is now the
  SDK's, maintained upstream; the entry is ~60 lines.
- The MCP contract cannot drift from the UI: a payload the renderer accepts is
  exactly what the agent receives, and the renderer's zod schemas are the
  MCP tool's argument + output contract. Cost semantics are the UI's
  query-time display pricing everywhere (superseding ADR 0019's base-cost note).
- The ledger-querying code lives in exactly one place (the seam + view
  builders); `tools.ts` is now pure composition.
- The MCP server is conversation-independent: spawned once per run but with
  no per-conversation state, so a scope change in the UI mid-conversation
  needs no new spawn and a single server can serve any window the agent
  queries. Filtering autonomy lives with the harness, guided by the
  briefing's `scope`-argument contract.
- The MCP process pulls more of the main bundle (the seam + view builders),
  all of which is electron-free; the plain-node self-serve spawn is unchanged.
- The server now serves the FULL MCP primitive set: tools, resources
  (`ledger://scope` — the same `describeLedgerScope` the `ledger_scope` tool
  runs, `ledger://overview` — the UI Overview payload as JSON, `ledger://schema`
  — a self-documenting table/tool/primitive index) and prompts
  (`coach-orient` — the briefing + first-step nudge; the separate `build-skill`
  prompt template was deleted with the mode — ADR 0021). All three surfaces
  reuse the same seam and the same main-side prompt builders, so no MCP surface
  can drift from the UI or from a `coach:run`. Resources and prompts ride the
  SDK natively — no hand-rolled protocol extension.
