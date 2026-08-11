# ADR 0019 — In-app ledger MCP server + per-conversation temp workspace

- Status: accepted
- Date: 2026-08-11
- Domain: agents (Coach & Skills surface), store (ledger, scope)
- Map: [Ledger-backed Coach & Skills — in-app ledger MCP server + per-conversation temp workspace](https://github.com/Pasquale-Favella/watchtower/issues/53)

## Context

The Coach & Skills surface (ADR 0016/0017/0018) asked the user to pick a
workspace for every harness run and gave the agent nothing but an empty repo —
it could not see the platform's own data (the accumulating ledger, ADR 0002)
even though answering questions about that data is the surface's job. The
user's redirection: **no workspace picker** — runs happen in a private temp
directory per conversation — and the harness must **access the platform data
to do its job**, scoped to the current UI scope.

## Decision

### 1. Per-conversation temp workspace, owned by the runner

The `coach:run` wire drops `workspacePath` entirely (ADR 0005 breaking change —
both sides move together in this repo). The main-process runner
(`createCoachRunner`) owns a private `mkdtemp(tmpdir()/watchtower-coach-*)`
directory:

- the directory is created on the conversation's first run and **reused for
  the whole conversation** — resumed runs (`sessionId` present) keep the
  harness's artifacts, and session-less runs (build-skill one-shots, which
  never resume) reuse it too, so a build-skill turn can never delete the
  coach conversation's cwd out from under a live ACP session;
- a new `coach:reset` IPC (fired by the renderer's `resetSession` and by
  `before-quit`) cancels active runs and deletes the directory — reset is
  the ONLY way a conversation's workspace is torn down.

The ACP agent's `cwd` is the temp directory; all real data access goes through
the ledger MCP server. The workspace-picker IPC (`coach:pick-workspace`), its
schema, and the control-strip chooser are removed; the strip shows a
data-context caption instead ("Last 30 days · all providers").

### 2. In-app, read-only ledger MCP server, scoped at spawn

Each run attaches a single `watchtower-ledger` MCP server to the agent's
session (`session.mcpServers`, forwarded verbatim by
`@mcpc-tech/acp-ai-provider` into the agent's `newSession`). The server is the
app itself, self-spawned as plain node:

- `command: process.execPath`, `args: [<out>/main/ledger-mcp.js, '--ledger-mcp']`,
  `env: ELECTRON_RUN_AS_NODE=1` + a `WATCHTOWER_LEDGER_MCP` JSON context
  (`dbPath`, scope). Works in dev (project `out/`) and packaged
  (`app.asar/out/` — Electron's plain-node mode reads asar). No new dependency:
  `@modelcontextprotocol/sdk` is only a transitive dep, so the server is a
  hand-rolled ~120-line JSON-RPC 2.0 subset (initialize, tools/list,
  tools/call, ping) over newline-delimited stdio — an electron-free second
  electron-vite main entry (`out/main/ledger-mcp.js`).
- The ledger is opened with a second `node:sqlite DatabaseSync(path,
  { readOnly: true })` connection — safe against the app's own WAL-mode
  connection, DDL-forbidden, SELECT-only (port-in stays the only writer).
- The scope is the conversation's snapshot of the current UI scope
  (`overviewScopeSchema`, sent on `coach:run`), baked at spawn as epoch-ms
  boundaries + optional provider; range filtering is done SQL-side via
  `strftime('%s', timestamp)` epoch comparisons (avoids the local-midnight →
  UTC shift of string comparison). Per-call filters ride tool arguments.

**Tools** (each read-only, scope-filtered):

| Tool | Returns |
|---|---|
| `ledger_scope` | the baked scope + counts inside it (sessions/calls/cost/providers) |
| `ledger_summary` | totals + tokens + per-model/category/skill/project/tool/bash breakdowns |
| `ledger_sessions` | per-session rows (filters: limit, model, project, category) |
| `ledger_calls` | raw call rows, newest first (filters: limit, model, project, category, tool) |

Costs are the ledger's stored `base_cost_usd` — query-time pricing overrides
are a view concern and are not applied server-side.

## Consequences

- The harness agent (Claude Code, OpenCode, Codex, …) can now answer questions
  about the user's telemetry and reason over skill evidence directly from the
  platform ledger, in the exact window the user is looking at.
- The renderer's scope store is the single source of the data context — a
  mid-conversation scope change snapshots on the next run (each run spawns a
  fresh server process).
- The hand-rolled MCP server only speaks the tools subset; adding capabilities
  (resources, prompts, a configurable server list) is deliberately out of
  scope. A future MCP SDK adoption would be a swap at the protocol layer.
- Windows caveat: `cmd.exe /c` shim wrapping already applies to the ACP
  command; the MCP server itself is spawned by the agent with
  `ELECTRON_RUN_AS_NODE`, unaffected by the shim.
