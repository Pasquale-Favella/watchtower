# ADR 0025 — Ledger MCP HTTP fallback for stdio-rejecting harnesses

- Status: accepted
- Date: 2026-09-16
- Domain: agents (Coach & Skills surface), ledger MCP transport
- Amends: ADR 0020 (which assumed every ACP agent spawns client-provided
  stdio MCP servers from the session config).

## Context

The `watchtower-ledger` MCP server is injected into every Coach run as a
client-provided stdio server the harness agent spawns (ADR 0020). Live
testing with the Copilot CLI harness showed the agent answering with no
ledger data on every turn. Its own logs state the cause verbatim, on every
session setup:

> `Rejecting non-http/sse MCP server "watchtower-ledger" from client`

The Copilot CLI rejects client-provided stdio MCP servers outright — only
`http`/`sse` entries from the client are accepted — so the stdio injection
can never deliver ledger tools there, while the briefing keeps promising
them. Verified by process observation (no MCP child survives session setup)
and by protocol probes (stdio attach absent; a client-provided HTTP probe
server completes the full handshake and serves tool calls).

## Decision

### 1. Per-harness client MCP transport (default stdio)

`HarnessSpec.clientMcpTransport?: 'stdio' | 'http'` (default `'stdio'`).
Only `copilot` sets `'http'` — the one harness with logged rejection
evidence. Every other harness keeps the proven agent-spawned stdio path;
unknown keys degrade to stdio.

### 2. Loopback-HTTP sidecar for the `http` policy

The same bundle serves the same tools over StreamableHTTP
(`--ledger-mcp-http` entry mode, `http-server.ts` handler, stateless
transports over the shared read-only store). The app boots it as plain node
on an ephemeral 127.0.0.1 port per run (`sidecar.ts`), hands the agent an
`http` server config with a per-spawn bearer token, and kills it when the
run's stream settles (end, error, or cancel). No new dependencies (node:http
+ the existing MCP SDK); minimal spawn env (no app secrets inherited).

### 3. Booking the failure mode

A sidecar that fails to boot degrades to the fresh-install shape (no data
tools, no briefing) rather than failing the turn — the same honesty rule
the briefing already follows. Verified end to end: a real Copilot run
against the production bundle called `watchtower-ledger-ledger_scope` over
the sidecar and reported DB-exact counts.

## Consequences

- Copilot Coach runs are ledger-grounded; all other harnesses are untouched.
- Per-run sidecar spawn adds sub-second latency to Copilot first tokens.
- If another harness ever logs the same rejection, the fix is one spec line.
- Residual, out of scope: Copilot cross-process session loads are
  intermittently `Resource not found` (its own persistence race) — that
  surfaces as explicit resume errors, not silent no-data, and is covered by
  the existing expendable-resume fallback for probe-warmed sessions.
