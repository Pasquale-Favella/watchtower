# Research: drivability matrix of the 38 parsed harnesses

Pathfinder map 27, ticket 28. Sources: TanStack AI harness docs (tanstack.com/ai/latest/docs/sandbox/harnesses), per-tool docs via web research, plus the codebase census (`src/main/pipeline/providers/*.ts`) for tool identity.

Legend: **drivable** = a standalone CLI the main process could spawn. **borderline** = CLI exists but unverified / cloud-backed / needs confirm during roasting. **parse-only** = IDE-embedded or no spawnable CLI.

## Drivable — first-party @tanstack adapter (high confidence)

| Harness | CLI | Adapter | ACP | Census source | Install |
|---|---|---|---|---|---|
| Claude | claude | @tanstack/ai-claude-code (claudeCodeText) | no (bridged) | pricing snapshot + getShortModelName | claude.ai/install.sh |
| Codex | codex | @tanstack/ai-codex (codexText) | no (bridged) | codex.ts modelDisplayNames + pricing | npm -g @openai/codex |
| OpenCode | opencode / opencode-ai | @tanstack/ai-opencode (opencodeText) | no (bridged) | opencode.ts modelDisplayNames + pricing | npm -g opencode |
| Grok Build | grok | @tanstack/ai-grok-build (grokBuildText) | no (bridged) | grok.ts -> getShortModelName | npm -g @xai/grok-build |

## Drivable — ACP speaker, no first-party adapter

| Harness | CLI | Adapter | ACP | Census source | Install |
|---|---|---|---|---|---|
| Gemini | gemini | none (acpCompatible) | native (--acp) | gemini.ts -> getShortModelName + aliases | npm -g @google/gemini-cli |
| Pi | pi | none (acpCompatible) | native (--acp) | pi.ts modelDisplayNames | npm -g (pi cli) |
| Goose | goose | none (acpCompatible) | plugin | goose.ts modelDisplayNames | block.github.io/goose install script |
| Zed | zed | none | native (ACP originator) | zed.ts -> getShortModelName | zed.dev install script |

## Drivable — no adapter, no ACP (direct-spawn candidates)

| Harness | CLI | Adapter | ACP | Census source | Confidence |
|---|---|---|---|---|---|
| Droid | droid | none | ? | droid.ts -> getShortModelName | medium |
| ZCode | zcode | none | no | aliases (GLM-5.2) | medium |
| Zerostack | zerostack (Rust) | none | no | pricing | medium |
| Crush | crush (charmbracelet) | none | no | pricing | medium |
| Devin | devin | none | no (cloud) | devin.ts -> getShortModelName | medium (cloud-backed) |
| Qwen Code | qwen | none | ? | qwen.ts -> getShortModelName | medium |
| Kimi | kimi | none | ? | kimi.ts -> getShortModelName | medium |
| Kimi Code | kimi-code | none | ? | kimicode.ts -> getShortModelName | medium |
| Cline | cline (cline-cli) | none | plugin | cline.ts (VS Code tasks) | borderline — VS Code-ext first, CLI exists |
| Roo Code | roo (roo-cli) | none | plugin | roo-code.ts (VS Code) | borderline |
| Codebuff | codebuff | none | ? | pricing | medium |
| OpenClaw | openclaw | none | ? | openclaw.ts | medium |
| LingTai TUI | lingtai | none | ? | lingtai-tui.ts | medium |
| Mistral Vibe | vibe | none | ? | mistral-vibe.ts | medium |
| Hermes Agent | hermes | none | ? | hermes.ts (sqlite) | medium |
| Copilot CLI | github-copilot / gh copilot | none | ? | copilot.ts (VS Code workspace) | borderline — CLI is terminal assistant |
| Forge | forge | none | ? | forge.ts (sqlite) | borderline — identity unverified |
| Mux | mux | none | ? | mux.ts | low — identity unverified |
| Open Design | open-design | none | ? | open-design.ts | low |
| CodeWhale | codewhale | none | ? | codewhale.ts | low |

## Parse-only (IDE-embedded / no spawnable CLI) — out of scope for the run side

| Harness | Why |
|---|---|
| Cursor | VS Code fork, embedded; no standalone agent CLI |
| Cursor Agent | embedded background agent of Cursor |
| Copilot (IDE) | VS Code/JetBrains embedded (workspace.yaml); CLI is a separate surface |
| Antigravity | Google AI IDE/cloud extension |
| KiloCode | VS Code extension (kilocode.kilo-code) |
| IBM Bob | VS Code extension (ibm.bob-code) |
| Quick Desktop | desktop app (sqlite) |
| OMP | companion surface of pi; identity unverified |
| Vercel AI Gateway | network service (network: true), not a local CLI |
| Warp | terminal emulator with AI feature (GUI app) |
| Devin | cloud agent (local CLI exists but cloud-backed) — see drivable/borderline |

## Notes for the roasting phase

- The **borderline/low-confidence** rows (Cline, Roo, Copilot CLI, Forge, Mux, Open Design, CodeWhale, OMP) need a verification pass — the exact CLI binary and its drivability should be confirmed before tickets 30-33 treat them as in-scope.
- Census source per harness is split across three places: per-provider `modelDisplayNames` maps, the pricing snapshot / LiteLLM keys (models.ts), and provider-specific aliases (BUILTIN_ALIASES). This feeds ticket 32 (model pick lists).
- ACP speakers with no first-party adapter (Gemini, Pi, Goose, Zed, Cline, Roo) are the `acpCompatible` set — feeds ticket 31.
