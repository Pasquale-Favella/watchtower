# ADR 0027 — Single-transport HTTP ledger server with direct external use (proposed)

- Status: proposed
- Date: 2026-09-16
- Domain: agents (Coach & Skills surface), ledger MCP transport
- Amends (when accepted): ADR 0020 (stdio injection), ADR 0025 (per-harness
  transport policy), ADR 0026 (per-conversation pool lifetime).

## Context

The ledger MCP server speaks two transports: agent-spawned stdio (the
default for 13 harnesses) and the pooled loopback-HTTP sidecar (Copilot
only, ADRs 0025/0026). Two transports means two spawn paths, two lifecycle
stories, and a server the user can never reach except through Coach turns.
The proposal: one HTTP server for everything, directly consumable from the
user's own harness configs — no Coach turn required.

Two facts bound the design. First, the evidence bar runs both ways: ADR
0025 flipped Copilot on a *logged* rejection, so flipping any harness to
HTTP needs positive proof (a live turn calling a ledger tool over HTTP),
not assumption — an agent that cannot consume client-provided http servers
would otherwise lose ledger grounding silently. Second, today's endpoint is
unconsumable externally by construction: ephemeral port per spawn,
per-spawn token, dead with the conversation. Direct use needs a stable
endpoint, a long-lived token, and an app-lifetime server — plus collision
handling, because the app has no single-instance lock (dev and packaged
builds side by side would fight over a fixed port).

## Decision (staged; each stage ships and reverts independently)

### Stage 1 — Per-harness HTTP proof, stdio stays as fallback

For each harness below: point a real Coach run at a pooled HTTP sidecar
(same pool, policy override) and require a ledger tool call with DB-exact
results — the ADR 0025 bar, mirrored. Flip `clientMcpTransport` per proven
harness only. Stdio is deleted only after the last flip.

| Harness | HTTP proof (live tool call, DB-exact) | Flipped |
|---|---|---|
| copilot | done (ADR 0025) | yes |
| opencode | done 2026-09-16 (`watchtower-ledger_ledger_scope`, sessions 1 / calls 2) | yes |
| codex | done 2026-09-16 (`mcp.watchtower-ledger.ledger_scope`, sessions 1 / calls 2) | yes |
| claude | blocked — account spend limit, zero tool attempts (not disproven; retry with credits or `allowApiKeyEnv`) | |
| pi | blocked on adapter — `pi-acp` declares `mcpCapabilities: {http:false, sse:false}` and a live HTTP run never surfaced ledger tools; stays stdio until upstream supports http | |
| gemini | | |
| grok | | |
| goose | | |
| qwen | | |
| kimi | | |
| cline | | |
| kilo-code | | |
| cursor | | |
| droid | | |

Note (2026-09-16): pi's verdict also bounds Stage 3 — stdio cannot be
deleted while any shipped adapter declares no-http. The `clientMcpTransport`
policy field stays until every remaining row is either proven or retired.

### Stage 2 — App-lifetime singleton with a stable, documented endpoint

One server per app instance (replacing the per-conversation pool): start at
ready once `ledger.db` exists, stop on quit. Stable loopback port with a
documented fallback chain on collision (fixed primary, next-free on
`EADDRINUSE`, actual port surfaced in Settings — never silent wrong-port).
Persistent bearer token in `userData`, display + rotate in Settings, per-harness
client config snippets in docs. Loopback-only is kept; the plaintext-token
tradeoff is booked here, not discovered later. Multi-instance behavior
(port fight vs single-instance lock) is decided in this stage, not during.

### Stage 3 — Delete stdio

Remove `--ledger-mcp` stdio mode, `StdioServerTransport` usage,
`buildLedgerMcpServer`, the `clientMcpTransport` spec field, and the
per-harness branching — only when the Stage 1 table is complete. The
in-memory server unit tests stay (transport-agnostic).

## Consequences (on acceptance)

- Follow-up turns and first tokens get faster everywhere (no per-session
  spawn on any harness), and the user can ground any MCP-capable harness
  from outside the app.
- The app owns one more always-on process plus a token-management UI —
  product surface that must be designed, not just deleted-into.
- Until Stage 3, both transports coexist; the policy field is the seam that
  makes each flip a one-line, provable step.
