# Data-driven harness registry: one spec file per harness, ACP-driven runtime, dynamic model discovery

Status: accepted (revised — SDK pivot: TanStack AI SDK → AI SDK v6 + ACP provider)

## Context

Ticket 20 introduced the HarnessRuntime seam and a Harness registry parallel to the Provider registry (ADR 0006). The initial registry drove three coding-agent CLIs (claude, opencode, codex) from a hardcoded `HarnessKind` union with inline `SPECS` / `MODELS` / `SCRUB_ENV` / `PREFERENCE` tables, on the TanStack AI SDK (`@tanstack/ai` + per-harness adapter packages). The parse side already reads 38 harnesses as data sources; the user's bar was to drive every technically drivable one on the run side — the majority of the 38.

**Revision (this ADR):** before the seam landed, the run side was pivoted OFF the TanStack AI SDK and onto the **AI SDK** (`ai` v6) with the **ACP provider** (`@mcpc-tech/acp-ai-provider`). The TanStack adapter packages (`@tanstack/ai-claude-code`, `-opencode`, `-codex`, `-grok-build`, `ai-sandbox*`) are uninstalled; ACP is the driver for every runnable harness.

## Decision

Pathfinder map 27 resolved eight tickets that together define the expanded registry architecture. This ADR summarises the architecture as built.

### 1. One spec file per harness (mirrors the Provider registry)

Each drivable harness gets a single file under `agents/harnesses/<name>.ts` exporting a `HarnessSpec`. A central `agents/harnesses/index.ts` collects them. The detection core (`detect.ts`) and the runtime seam iterate specs generically; a new harness is a new spec file, never an edit to the core module. This mirrors the per-file convention of `src/main/pipeline/providers/` (ADR 0006).

### 2. Full spec shape with a discriminated-union adapter descriptor

Each `HarnessSpec` carries:
- `commands[]`: CLI names probed on PATH, in order (aliases last). For ACP harnesses the probe is the SPAWN TARGET — the ACP server binary (e.g. `claude-agent-acp`, `codex-acp`), never the base CLI whose presence would not make the harness drivable. OpenCode and Grok speak ACP with their own binary, so their probe is that same binary.
- `displayName`: human-readable label
- `scrubEnv[]`: env vars dropped before spawn (host CLI login, no API keys — ADR 0012)
- `modelListCommand`: the CLI command for dynamic model discovery (e.g. `opencode models`)
- `fallbackModels`: the pick list used when dynamic discovery is absent or fails
- `adapter`: a discriminated union describing how to construct the harness adapter:
  - `{ kind: 'acp', acpConfig }` — maps 1:1 to `createACPProvider()` settings (`command`, `args`, optional `mcpServers`, optional `authMethodId`). This is the ONLY runnable kind today.
  - `{ kind: 'direct', spawn }` — placeholder for a generic raw-CLI driver (command template + output contract), deferred.

The former `{ kind: 'first-party', pkg, export }` TanStack-adapter kind is **removed** with the SDK pivot.

### 3. Dynamic model discovery per harness (tiered fallback)

Model pick lists are discovered dynamically from each harness's own CLI command (e.g. `opencode models [provider]`). When a harness has no list command, the command fails, or the CLI is not logged in, fall back to the spec's `fallbackModels`. ACP agents may additionally expose `availableModels` through the protocol handshake (`initSession()`); `provider.languageModel(modelId)` selects among them when the agent supports it.

### 4. Adapter selection rule (applied in order)

1. **ACP wins** — every runnable harness is driven over the Agent Client Protocol via `createACPProvider({ command, args, session: { cwd, mcpServers }, ... })`; the seam injects the real workspace as `session.cwd` and the scrubbed env (ADR 0012).
2. Else **direct spawn** via a generic raw-CLI driver (deferred placeholder).
3. Else **parse-only** — never on the run side.

Launch commands follow the official ACP registry (`agentclientprotocol.com/registry`): `claude-agent-acp`, `codex-acp`, `opencode acp`, `grok agent stdio`, `gemini --acp`, etc. A new ACP-speaking harness is a new spec file with its registry launch command.

### 5. Data-driven preference order

`PREFERENCE` becomes a per-spec preference field (lower = higher priority). The default harness is the first detected-and-configured harness in preference order. Reordering is a data edit, not a code edit.

### 6. Per-run harness + model pickers in the Coach surface

The Coach run surface exposes harness and model pickers, defaulting to the preferred harness, populated from the dynamic model lists. The picker respects authStatus: configured harnesses beat unknown ones; the default picks the first configured one.

### 7. Session resume over ACP

The AG-UI session-id custom-event mechanism (`<name>.session-id`) is gone with the TanStack stack. Session resume is now the ACP provider's own handle: a run receives `existingSessionId` from the previous run's `session` CoachEvent, the seam passes it to `createACPProvider({ existingSessionId })`, and a fresh session id is surfaced from `initSession()`. The seam does NOT set `persistSession` — each run spawns a fresh agent process and tears it down on completion (cleanup in the outer `finally`), relying on the agent's own on-disk session persistence for resume.

### 9. CoachEvent derivation over AI SDK stream parts

`deriveCoachEvents` consumes the AI SDK `streamText().fullStream` parts (ADR 0005) instead of raw AG-UI chunks: `text-delta` → text, `tool-input-start` → tool notice (the ACP provider announces each tool with its REAL name here), `finish` → done, `error` → error. The ACP provider's dynamic-tool `tool-call` parts (`acp.acp_provider_agent_dynamic_tool`) wrap the SAME call already announced by `tool-input-start`, so they are skipped to avoid duplicate notices. Raw plan/diff/terminal chunks are not part of the Coach surface and are dropped.

### 8. Types

`HarnessKind` (closed union) is replaced by `kind: string` (canonical tool name). The public `HarnessInfo` shape stays stable (name, kind, displayName, bin, models, scrubEnv, authStatus) for the renderer/IPC.

## Consequences

- The registry scales to any ACP-speaking harness by adding spec files — no modifications to the core detection or runtime modules.
- The Provider registry convention (one file per tool, central index) is mirrored perfectly, making the parallel structure (ADR 0006) consistent.
- `HarnessKind` widens from a closed union to `string` — the renderer should treat it as opaque.
- One SDK dependency pair replaces seven TanStack packages: `ai` + `@mcpc-tech/acp-ai-provider` (both ESM, lazily imported by `loadHarnessSdk()`).
- Sandbox middleware is no longer used: ACP agents run locally against the workspace (`session.cwd`); the seam validates the workspace is a real on-disk directory before any spawn (ticket 15 constraint).
- ACP agents report no token usage (the protocol returns 0), so the run seam contributes no token/cost telemetry of its own; telemetry continues to come from the parse side's session-file reads.
- The `direct` adapter descriptor is a placeholder for a generic raw-CLI driver whose design is deferred to the build phase.
