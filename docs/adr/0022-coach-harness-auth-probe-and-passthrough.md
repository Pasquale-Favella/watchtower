# Coach harness auth: sign-in probe, actionable errors, API-key passthrough opt-in

Status: accepted

## Context

Coach runs drive harness CLIs over ACP with the host env scrubbed of API
keys (ADR 0012), so agents fall back to their own stored login. Two failure
modes surfaced with Claude Code:

1. **The model picker looks healthy while runs fail.** The ACP handshake
   (`initSession` → `session.new`) reports models/modes WITHOUT
   authenticating; only the first prompt turn hits the stored login. An
   expired OAuth session therefore shows a populated picker and then fails
   with a raw `ACPError … authentication_failed` that says nothing actionable.
2. **Terminal sign-in ≠ app sign-in.** A terminal that authenticates via
   `ANTHROPIC_API_KEY` works, while the app — which scrubs that key by
   design — falls back to the expired stored login and fails. Detection had
   an `authProbe` seam for exactly this signal, but it was never wired, so
   every harness reported `authStatus: 'unknown'`.

Dependency updates pulled in alongside: `@mcpc-tech/acp-ai-provider`
0.3.5 → 0.3.8 and `@agentclientprotocol/claude-agent-acp` 0.66.0 → 0.77.0.
The 0.77.0 breaking change (removed agent-picker exports) does not touch the
seam — verified by grep, plus typecheck and the seam test suite. The 0.75.0
`authStatus` push extension is noted but NOT consumed: it arrives as an
`_auth/status_update` extension notification the AI SDK provider does not
forward, so the seam probes the CLI directly instead.

## Decision

1. **Claude sign-in probe** (`src/main/agents/auth-probe.ts`): runs
   `claude auth status --json` (5 s timeout, Windows `.cmd` shim like the
   runtime seam) and maps ONLY the `loggedIn` boolean to
   `configured`/`unknown`. Never throws — every failure resolves to
   `unknown`, which stays purely informative and never blocks a run. Wired
   as the `authProbe` for the `claude` kind in `registerAgentsIpc`; other
   harnesses keep `unknown` until they grow their own probe.
2. **Actionable auth errors** (`runtime.ts`): warm-up, resume-fallback, and
   stream-time failures matching auth-wall signatures become a sign-in hint
   (`claude auth login`, plus the passthrough pointer for Claude) with the
   raw detail appended. Non-auth errors pass through byte-identical;
   resume-handle expiries deliberately do NOT match (they own a retry path).
3. **API-key passthrough opt-in** (default OFF — ADR 0012's stored-login
   default is unchanged): `allowApiKeyEnv` rides `coach:run` and
   `coach:inspect` (schema minor extension, backward-compatible), skips env
   scrubbing for that spawn, and is honoured by probe-warmed session resume
   (a flag mismatch starts fresh rather than resuming a wrongly-spawned
   session). The renderer persists the flag as a Coach setting with a toggle
   next to the Claude composer; the key itself is never stored or sent —
   only the scrub decision crosses IPC.

## Consequences

- The picker tooltip and default-harness preference are honest for Claude
   before any spawn; auth walls fail with a remedy instead of a protocol
   error code.
- Key-based terminal users can make Coach work by enabling passthrough
   (the key must be in the APP process's own environment — e.g. launch the
   app from that terminal or set it at user level).
- `coach:inspect` accepts the bare key (legacy) or `{ kind, allowApiKeyEnv }`.
