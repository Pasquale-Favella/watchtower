# ADR 0027 — App-scoped local ledger MCP and startup controls

- Status: accepted
- Date: 2026-09-16
- Domain: agents (Coach & Skills surface), local MCP integration
- Amends: ADR 0026

## Context

ADR 0026 pooled the HTTP ledger sidecar per Coach conversation. The same
read-only, stateless server can also serve MCP-compatible applications that
the user runs locally, but conversation reset should not disconnect those
clients. Starting the sidecar on the first Coach turn also adds avoidable
latency when the user already knows they will use the local MCP endpoint.

## Decision

The loopback HTTP sidecar is app-scoped. It is shared by Copilot, future
stdio-rejecting harnesses, and explicitly configured local MCP clients. A
conversation reset only resets the Coach workspace; it does not stop the
sidecar. App quit releases it.

The Settings › Local MCP pane exposes three controls:

1. Startup: `On demand` (default) or `At Watchtower launch`.
2. Copy a provider-neutral `mcpServers` JSON configuration containing the
   current loopback URL and bearer token.
3. Regenerate the bearer token, replacing the running sidecar and invalidating
   previously copied configurations.

The URL remains bound to `127.0.0.1`. The startup preference is persisted in
the ledger's config tables; bearer tokens are runtime-only and are never
persisted. Copying the configuration is the explicit action that reveals a
token to the renderer/user.

## Consequences

- Copilot and local external clients share one healthy sidecar and avoid
  repeated boot/readiness costs.
- The HTTP endpoint is available only while Watchtower is running and only on
  the local machine.
- Regenerating the token disconnects existing clients until they receive the
  new configuration.
- stdio MCP attachments remain harness-owned and continue to be created per
  ACP session; they are not converted into shared processes.
