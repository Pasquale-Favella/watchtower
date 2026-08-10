# Data-driven harness registry: one spec file per harness, adapter descriptor union, dynamic model discovery

Status: accepted

## Context

Ticket 20 introduced the HarnessRuntime seam and a Harness registry parallel to the Provider registry (ADR 0006). The initial registry drove three coding-agent CLIs (claude, opencode, codex) from a hardcoded `HarnessKind` union with inline `SPECS` / `MODELS` / `SCRUB_ENV` / `PREFERENCE` tables. The parse side already reads 38 harnesses as data sources; the user's bar was to drive every technically drivable one on the run side — the majority of the 38.

## Decision

Pathfinder map 27 resolved eight tickets that together define the expanded registry architecture. The decisions are recorded in full on the map (issue #27) and its eight child tickets. This ADR summarises the architecture.

### 1. One spec file per harness (mirrors the Provider registry)

Each drivable harness gets a single file under `agents/harnesses/<name>.ts` exporting a `HarnessSpec`. A central `agents/harnesses/index.ts` collects them. The detection core (`detect.ts`) and the runtime seam iterate specs generically; a new harness is a new spec file, never an edit to the core module. This mirrors the per-file convention of `src/main/pipeline/providers/` (ADR 0006).

### 2. Full spec shape with a discriminated-union adapter descriptor

Each `HarnessSpec` carries:
- `commands[]`: CLI names probed on PATH, in order (aliases last)
- `displayName`: human-readable label
- `scrubEnv[]`: env vars dropped before spawn (host CLI login, no API keys — ADR 0012)
- `modelListCommand`: the CLI command for dynamic model discovery (e.g. `opencode models`)
- `fallbackModels`: tiered fallback from the @tanstack adapter package's exported list (`CLAUDE_CODE_MODELS` / `OPENCODE_MODELS` / `CODEX_MODELS`) to the existing census
- `adapter`: a discriminated union describing how to construct the harness adapter:
  - `{ kind: 'first-party', pkg, export }` — dedicated @tanstack adapter (e.g. `@tanstack/ai-claude-code` → `claudeCodeText`)
  - `{ kind: 'acp', acpConfig }` — `acpCompatible()` config (name, command template, authMethodId, permissionMode)
  - `{ kind: 'direct', spawn }` — generic raw-CLI driver (command template + output contract)

`loadHarnessSdk()` builds adapters from specs, so `runtime.ts` has zero per-harness code.

### 3. Dynamic model discovery per harness (tiered fallback)

Model pick lists are discovered dynamically from each harness's own CLI command (e.g. `opencode models [provider]`). When a harness has no list command, the command fails, or the CLI is not logged in, fall back to the @tanstack adapter package's exported model list, then to the existing census. ACP harnesses cannot be discovered over the protocol (the client selects the model per session) and sit on the fallback tiers.

### 4. Adapter selection rule (applied in order)

1. **First-party adapter wins** when the harness has one (curated per-model metadata, run journaling on durable runs, vendor approval behavior)
2. Else **ACP** via `acpCompatible` (client-driven models, session resume via `<name>.session-id`)
3. Else **direct spawn** via a generic raw-CLI driver (non-interactive command template + per-harness output contract)
4. Else **parse-only** — never on the run side

Research confirmed 11 ACP speakers in the census: pi, gemini, grok, goose, cline, cursor, zed, opencode, qwen, kimi, kimi-code. Verifiable direct contracts: qwen `-p`, copilot-cli `suggest`, zerostack.

### 5. Data-driven preference order

`PREFERENCE` becomes a per-spec preference field (lower = higher priority). The default harness is the first detected-and-configured harness in preference order. Settled order: first-party adapters by maturity → ACP speakers → direct. Reordering is a data edit, not a code edit.

### 6. Per-run harness + model pickers in the Coach surface

The Coach run surface exposes harness and model pickers, defaulting to the preferred harness, populated from the dynamic model lists. The picker respects authStatus: configured harnesses beat unknown ones; the default picks the first configured one.

### 7. Types

The `HarnessKind` literal union is replaced by `kind: string` (canonical tool name). The public `HarnessInfo` shape stays stable (name, kind, displayName, bin, models, scrubEnv, authStatus) for the renderer/IPC.

## Consequences

- The registry scales from 3 to ~18 drivable harnesses by adding spec files — no modifications to the core detection or runtime modules.
- The Provider registry convention (one file per tool, central index) is mirrored perfectly, making the parallel structure (ADR 0006) consistent.
- `HarnessKind` widens from a closed union to `string` — the renderer should treat it as opaque.
- Dynamic model discovery adds a subprocess call per harness at detection time; the last-known list survives a failed query (stale-while-revalidate, mirroring the scan posture).
- The `direct` adapter descriptor is a placeholder for a generic raw-CLI driver whose design is deferred to the build phase; drivers are only written for CLIs whose non-interactive mode and output contract are verified on a real binary.
- The expanded registry is sequenced as a parallel lane gated on the foundation (ticket 20's HarnessRuntime seam) merging to main first. Coach's first iteration keeps the 3-harness registry; breadth + pickers land as a follow-on.
