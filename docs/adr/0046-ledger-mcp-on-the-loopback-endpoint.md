# Ledger MCP served from the in-process loopback endpoint

- Status: accepted
- Date: 2026-11-23
- Domain: agents (Coach & Skills), ledger MCP transport, Settings › Local MCP
- Supersedes in part: ADR 0019 section 2 (the self-spawned stdio server), ADR 0020 (the separate query process),
  ADR 0025 (the loopback sidecar and its per-harness transport), ADR 0026 (the pooled sidecar) and the sidecar process
  that ADR 0027 describes. ADR 0027's controls stand.

## Context

The `watchtower-ledger` MCP server ran as a separate process in four forms. ADR 0019 and ADR 0020 started a stdio
server from the app bundle with its own read-only SQLite connection. ADR 0025 ran a loopback HTTP sidecar for each
run, for harnesses that reject stdio servers. ADR 0026 pooled that sidecar per conversation, and ADR 0027 made it
app-scoped for Settings › Local MCP. Each process had its own boot, readiness check, port and token lifecycle, and
its own SQLite runtime.

The orchestrator and browser endpoints had already moved to an in-process bearer endpoint, acquired within a scope
(ADRs 0041 and 0044). The ledger was the one MCP server still running as a child process.

## Decision

1. **In-process endpoint.** The ledger is served by `acquireLoopbackMcp` through `acquireLedgerMcp`, the same
   mechanism as the orchestrator and browser endpoints. Each agent Driver Connection scope acquires its own endpoint,
   with a random bearer token bound to 127.0.0.1. Settings › Local MCP acquires one app-scoped endpoint.
2. **Attachment.** The endpoint is attached over HTTP when the harness accepts HTTP MCP servers. Otherwise a
   `ledger-mcp-proxy` stdio bridge (`src/platform/mcp/ledger-proxy-entry.ts`) carries it. The bridge runs under
   `ELECTRON_RUN_AS_NODE` and reads `WATCHTOWER_LEDGER_MCP_URL` and `WATCHTOWER_LEDGER_MCP_TOKEN`. This follows
   the rule ADR 0044 sets for the orchestrator, so the per-harness `clientMcpTransport` of ADR 0025 is removed.
3. **Reads through the DB worker.** The tools and resources query through `LedgerMcpQueries`, which runs on the
   database worker (ADR 0023). A request that is cancelled cancels its read. The MCP path has no second SQLite runtime.
   The endpoint exposes read tools and resources only.
4. **Removed.** The sidecar entry and its child process, the per-conversation pool, the READY-line port handshake, the
   parent-liveness check, the app-scoped sidecar process, and the separate ledger-mcp build entry.
   `verify-packaged` exercises both the HTTP and the stdio transport against the packaged app.
5. **Settings › Local MCP keeps its controls.** Startup is `on-demand` (the default) or `at-launch`. Copying the
   `mcpServers` configuration reveals the current loopback URL and bearer token. Regenerating the token replaces the
   endpoint's token and invalidates copied configurations. The endpoint stays on 127.0.0.1, the token is never
   persisted, and copying is the only action that reveals it.
6. **Lifetime.** An agent endpoint lives as long as its Driver Connection scope. The Settings endpoint lives while the
   app runs and closes on quit; that lifetime concerns the Settings › Local MCP endpoint only. Coach agent sessions
   acquire their own Run-scoped ledger endpoint, so starting, stopping or resetting a Coach chat (ADR 0045) never
   touches the Settings endpoint.

## Consequences

- One SQLite runtime serves the ledger, and ledger reads share the database worker's queue and cancellation.
- There is no child process to boot, no port to pick, and no orphan to reap. The stdio bridge is the only child, and
  it lives for one harness session.
- Harness startup no longer waits on a readiness probe, so the first-turn latency of ADR 0025 is gone.
- Settings and agent endpoints hold separate tokens. Regenerating the Settings token invalidates only the
  configurations copied from Settings, and leaves agent endpoints unaffected.
- The evidence in ADR 0025 that some harnesses reject client-provided stdio servers still holds. It decides which
  attachment a harness receives, and it no longer decides a process topology.

## Alternatives rejected

- Keep the sidecar and share only its pool. This keeps a second SQLite runtime and a second lifecycle for a single
  endpoint.
