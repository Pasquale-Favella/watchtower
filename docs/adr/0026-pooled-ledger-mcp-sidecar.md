# ADR 0026 — Pooled ledger MCP sidecar for stdio-rejecting harnesses

- Status: accepted
- Date: 2026-09-16
- Domain: agents (Coach & Skills surface), ledger MCP transport
- Amends: ADR 0025 (which spawned one sidecar per run and picked its port
  parent-side).

## Context

ADR 0025 put the sidecar boot on the critical path of every Copilot turn:
each run spawned the full binary, waited out a health poll, and killed the
child on settle — even when the next message arrived seconds later. It also
picked the port parent-side (bind port 0, close, hope), a TOCTOU race whose
worst case was a 10-second health timeout followed by a silent no-data turn.

Reuse is safe: the sidecar carries no per-turn state (it serves the full
lifetime ledger, ADR 0020) and the ledger runs in WAL mode (ADR 0004's
store), so a long-lived read-only handle neither blocks writers nor goes
stale — every statement reads the latest commit.

## Decision

### 1. Per-conversation pool behind the existing seam (`pool.ts`)

One sidecar serves every turn of a conversation. The runner is untouched:
pooled attachments carry a no-op release, so the settle path still calls
`release()` exactly as before. Every acquire is health-gated — a sidecar
that died between turns is respawned, never handed out. Concurrent acquires
while a spawn is in flight share it. A reset racing a spawn kills the orphan
and degrades that turn to no-tools (the booked honesty rule). Conversation
reset/quit drops the pool; the next conversation spawns fresh.

### 2. Child-reported port over stdout (no parent probe, no race)

The sidecar binds port 0 itself and announces `READY {"port": N}` on stdout
after the listen callback; the parent reads one line with a timeout. The
spawn env carries only `dbPath` + `token`. The confirming health check stays
as a fast-path assertion (it passes first try on a healthy boot).

Hardening envelope (booked here, carried over from the 0025 implementation):
a 1 MB request-body cap, JSON `{error:...}` shapes (401/400/404/500), and the
bearer token gating every route including `/health` — "every route needs the
per-spawn bearer token" admits no unauthenticated surface, not even the
readiness probe the parent itself uses.

### 3. Parent liveness (`entry.ts`)

The child exits when `kill(ppid, 0)` reports ESRCH — a main-process crash
between spawn and release leaves no orphan holding a DB handle.

## Consequences

- Copilot follow-up turns skip spawn + boot + readiness entirely; only the
  conversation's first http-transport turn pays it.
- The 10-second port-collision failure mode is gone: no port is ever picked
  twice, and a malformed READY line is a fast boot failure, not a timeout.
- Token lifetime is per-conversation (one sidecar, one token) instead of
  per-run — same loopback-only exposure, fewer secrets minted.
- If another harness ever needs the `http` policy, it rides the same pool;
  the fix stays one spec line (ADR 0025 consequence, unchanged).
