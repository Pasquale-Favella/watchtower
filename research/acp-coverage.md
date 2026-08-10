# Research: ACP coverage of the 38 parsed harnesses

Pathfinder map 27, ticket 29. Sources: agentclientprotocol.com (protocol docs, fetched live), TanStack AI docs (Harnesses + ACP-Compatible Harness guides, fetched live), and ticket 13 findings (research/harness-matrix).

## ACP in one paragraph

- JSON-RPC 2.0 protocol between a Client (editor/app) and an Agent (coding agent). Local agents run as subprocesses over stdio; remote over HTTP/WebSocket (work in progress).
- Flow: `initialize` (version + capability negotiation) -> `authenticate` (if the agent advertises auth methods) -> `session/new` (or `session/load` to resume) -> `session/prompt` -> `session/update` notifications -> `session/cancel` -> stop reason.
- Extensible: `_meta` fields, `_`-prefixed custom methods, advertised capabilities.
- **The client selects the model** (`session/new` carries the model id) — there is no standard server-side "list my models" discovery method.

## acpCompatible (@tanstack/ai-acp) requirements

`acpCompatible(config)` returns a harness factory; call it with a model id (`harness('pi-pro')`).

| Field | Purpose |
| --- | --- |
| `name` (required) | Label + `<name>.session-id` event name |
| `models` | Declared model ids (type-safety only; omit = accept any string) |
| `command` (unless `openTransport`) | Builds the **stdio** launch command from `{ model, cwd, harnessCwd, sandbox, env, modelOptions, signal }` |
| `openTransport` | WebSocket/custom transports (e.g. `grok agent serve` pattern) via `startAcpServerInSandbox` |
| `skillsDir` | Harness skills dir relative to workspace (e.g. `.pi/skills`) |
| `cwd`, `env` | Working dir + extra env inside sandbox |
| `authMethodId` | ACP auth method to select before the session |
| `permissionMode` | `default` \| `acceptEdits` \| `bypassPermissions` (default) |
| `permissions` | `headless` (auto-resolve, default) \| `interactive` (emit approval events) |
| `refusalMessage`, `planEventName`, `emitDiff`, `onExtNotification`, `buildPrompt` | Optional behavior knobs |

**Covered by acpCompatible:** initialize, authenticate, session/new, session/load (resume), session/prompt, session/cancel, request_permission (all 4 kinds), agent_message_chunk / agent_thought_chunk / tool_call(+update) / plan updates, all 5 stop reasons. Session resume via the `<name>.session-id` CUSTOM event + `modelOptions.sessionId`.

**Not implemented (by design):** fs/* and terminal/* (the agent has direct FS inside the sandbox — fine for our local-process posture), multimodal prompt input, incremental usage_update. If a first-party adapter exists (claudeCodeText, codexText, opencodeText, grokBuildText), prefer it — curated per-model metadata.

## Coverage matrix — which of the 38 speak ACP

**Confirmed ACP speakers among the census:**

| Harness | ACP status | Notes |
| --- | --- | --- |
| Pi | native `pi --acp` | confirmed (ticket 13 + TanStack examples) |
| Gemini | native `gemini --acp` | confirmed |
| Grok Build | native (`grok agent serve` WS) | also has first-party grokBuildText |
| Goose | plugin | confirmed (ticket 13) |
| Cline | plugin/bridge | confirmed (ticket 13) |
| Cursor | plugin/bridge | confirmed (ticket 13) — but IDE-embedded, parse-only |
| Zed | native (ACP originator) | zed terminal agent runs over ACP |
| OpenCode | native ACP server | also has first-party opencodeText |

**Unverified — check before treating as in-scope:** Claude (experimental ACP serve?), Codex, Roo Code, Devin, Qwen, Kimi.

**Not ACP (as of research):** IDE-embedded tools without a CLI (cursor agent, antigravity, kilocode, ibm-bob, quick desktop, warp, vercel gateway) and the direct-spawn candidates (droid, zcode, zerostack, crush, codebuff, etc.).

## Model discovery fact (feeds ticket 32)

- ACP is **client-driven**: the client chooses the model per session. There is no standard "list models" method, and `acpCompatible`'s `models` array is declared by the integrator.
- Dynamic model lists therefore CANNOT come from ACP. They must come from the existing model census (per-provider `modelDisplayNames` maps / pricing keys) or from each CLI's own non-ACP query (e.g. `claude model list`) — CLI-specific, not protocol-provided.

## Wrap recommendation (feeds ticket 31)

- ACP is the run mechanism for census harnesses with no first-party adapter that speak ACP: **gemini, pi, goose, zed, cline, roo (verify)**.
- Run side splits into: first-party adapters (claude, codex, opencode, grok) + ACP (gemini, pi, goose, zed, cline, roo?) + direct-spawn candidates with neither (droid, zcode, zerostack, crush, ...) — the direct-spawn decision belongs to ticket 31.
