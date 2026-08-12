# ACP-real harness spec, typed seam, and progressive model/mode selection

Status: accepted

## Context

ADR 0016 (revised) and ADR 0017 shipped the data-driven harness registry and the unified Coach & Skills section on the AI SDK (`ai` v6) + `@mcpc-tech/acp-ai-provider`. Two things did not survive contact with the REAL provider (v0.3.5 installed):

1. **Model selection is a per-agent property, not a per-run picker.** The AI SDK docs say "you cannot select a specific model" — the ACP provider exposes ONE language model per configured agent (`provider.languageModel()`). The spec still carried TanStack-era model-list scaffolding (`modelListCommand`, `fallbackModels`) that implied selectable models the wire could never deliver. The installed provider, however, DOES implement `languageModel(modelId?, modeId?)` and can report `availableModels`/`availableModes` through `initSession()` (marked experimental/UNSTABLE in the ACP spec) — so selection is possible, but only when the AGENT declares its own options.

2. **The seam was typed against hand-rolled narrow slices.** `runtime.ts` defined its own `AcpProviderConfig`/`AcpProvider` interfaces with `as unknown as` casts at the SDK boundary — the seam could drift from what the provider actually accepts.

Additionally, the renderer's Coach & Skills surface was a single ~450-line `CoachSkillsView.tsx` monolith with raw `<select>`/`<button>` markup, unlike the rest of the app's shadcn-based views.

## Decision

Pathfinder map 47 resolved four decision tickets that together reshape the registry, the seam, and the renderer. This ADR summarises the architecture as built.

### 1. One harness = ONE agent = ONE language model (ticket 49)

`HarnessSpec` drops `modelListCommand` and `fallbackModels` entirely — the CLI-side model discovery scaffolding is removed. Selectable models/modes are discovered LIVE through the ACP handshake (`initSession()` → session event), never from spec data. `HarnessInfo` and the `CoachHarnessRow` wire row lose their `models` list — a harness is reported as one drivable agent, and nothing on the picker pretends otherwise.

`adapter.acpConfig` is now the STATIC slice of the real `ACPProviderSettings` type (`name`, `command`, `args`, `mcpServers` typed as the real `McpServer` union derived from the provider's settings type, `authMethodId`, `sessionDelayMs`). The seam fills in the per-run parts: `session.cwd` (workspace), `env` (scrubbed, ADR 0012), and `existingSessionId` (resume).

### 2. Seam typed against the real package (ticket 51)

`AcpProviderConfig` IS `ACPProviderSettings`; `AcpProvider` is `Pick<ACPProvider, 'languageModel' | 'tools' | 'initSession' | 'cleanup'>`. `loadHarnessSdk()` wires the real factory with no `as unknown as` at the provider boundary — the real signature satisfies the seam contract structurally. The only remaining cast is the `fullStream` → `CoachStreamPart` narrowing, which is inherent to the narrow event union.

### 3. Progressive model/mode selection over the handshake (ticket 50)

The seam's `initSession()` result may report `models` (`SessionModelState`) and `modes` (`SessionModeState`) — experimental ACP handshake fields. These ride the existing `session` CoachEvent as optional `models`/`modes`, and the run wire gains optional `modelId`/`modeId` which the seam forwards to `provider.languageModel(modelId, modeId)`.

The renderer renders model/mode pickers ONLY when the last session event reported a selectable set — "progressive: show when supported". A harness that does not declare options gets no picker and runs with the agent's default. The store keeps the declared set per harness and the user's picks, forwarding them on the next run.

### 4. Colocated shadcn-compliant renderer components (ticket 52)

`CoachSkillsView.tsx` is now a thin composition root over colocated components in `features/coach-skills/`: `control-strip.tsx` (harness/workspace/mode + progressive model/mode + candidate pickers), `thread.tsx` (Conversation + MessageBubble + ToolNotices + EmptyThread), `draft-card.tsx` (the build-skill result card), `composer.tsx` (PromptInput-inspired), and `lib.ts` (shared labels/helpers). All interaction primitives are the shared shadcn set (`Button`, `Select`, `Badge`, `Separator`, `Skeleton`, `Panel`) — the raw `<select>`/`<button>` markup is gone. Wide pattern inspiration came from elements.ai-sdk.dev (Conversation/Message, PromptInput, Tool cards, ModelSelector) without adding its dependency.

> **Updated (ADR 0021):** the colocated set has since been folded further — the
> surface now lives in `conversation.tsx` (welcome, composer, chips),
> `thread.tsx` (bubbles + notices), `blocks.tsx` (thinking/tool cards), and
> `model-selector.tsx`. `control-strip.tsx`, `composer.tsx`, and
> `draft-card.tsx` are gone.

## Consequences

- The registry no longer lies about models: a harness is one agent; selection is what the agent itself declares, surfaced only then.
- The seam can no longer drift from the real provider surface — the types ARE the package's types.
- Session-meta (`models`/`modes`) extends the frozen `coach:event` wire with optional fields (ADR 0005-compatible — old clients ignore them); `coach:run` replaces the dead `model` field with `modelId`/`modeId`.
- Renderer maintainability: each Coach & Skills UI concern is a small colocated file on the shadcn primitives, matching the rest of the app.
- `models`/`modes` remain UNSTABLE in the ACP spec — agents may report them or not; the progressive design degrades gracefully to no picker.
