# Agent driver verification

This records the M0.2 protocol spike for [issue #178](https://github.com/Pasquale-Favella/watchtower/issues/178). It does not certify the first workspace release. The new drivers are not connected to the production application yet. Coach still uses its existing execution path until the common service and its migration are implemented.

## Evidence and limits

| Driver           | Tested implementation                           | Evidence                                                                                                                                        | Open release gates                                                                                                                                                 |
| ---------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Codex App Server | Installed CLI `0.165.0`, native JSONL transport | Deterministic peer tests and an installed-process `initialize`/`initialized` handshake on Windows through the production Effect process adapter | Authenticated turns, full native event coverage, native requests beyond command/file approvals and user questions, packaged launch and supported operating systems |
| Claude Agent SDK | Official TypeScript SDK pinned to `0.3.270`     | Injected SDK tests for the callback and session contract                                                                                        | Authorized authentication and distribution route, real native turns, resume, descendant cleanup, packaged launch and supported operating systems                   |
| ACP              | Official client SDK pinned to `0.14.1`          | Protocol tests against a simulated ACP agent using the official SDK                                                                             | Real installed Harnesses, their negotiated capabilities, authentication, packaged launch and supported operating systems                                           |

The Codex handshake sends no prompt and performs no inference. It establishes process routing and protocol initialization on this host. Its response does not establish an authenticated account or a protocol version, so those identities remain unknown. The opt-in test uses `CODEX_APP_SERVER_SMOKE=1`; ordinary tests do not invoke installed agents.

The Claude candidate requires an explicitly provided API key and checks the native initialization evidence when it arrives. A fake SDK result cannot establish that an authentication route is permitted in a distributed application. Subscription support remains a product goal, and a BYOK-only product scope is not assumed.

## Current contract restrictions

| Operation         | Codex                                                  | Claude candidate                                                     | ACP                                                                   |
| ----------------- | ------------------------------------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Native session    | New thread or exact thread resume                      | Fresh session ID or exact SDK resume, with initialization validation | New session or exact load when advertised; one session per connection |
| Turn input        | User text                                              | User text                                                            | User text                                                             |
| Interrupt         | Native request acknowledgment; await terminal evidence | SDK control request; await native evidence                           | Cancel notification; await prompt settlement or close                 |
| Steering          | Expected native turn required                          | Unsupported                                                          | Unsupported                                                           |
| Requests          | Command/file approval and structured user questions    | Held SDK permission callback and supported question tool             | Held permission callback preserving native option identity            |
| Replay            | Bounded assistant text from thread history             | Unsupported                                                          | Bounded history captured during native session load                   |
| Live event cursor | Unsupported; operational replay belongs to the store   | Unsupported; operational replay belongs to the store                 | Unsupported; operational replay belongs to the store                  |
| Attachments       | Unsupported                                            | Unsupported                                                          | Unsupported                                                           |

An application Run ID is never presented as a native turn ID. Native request delivery and local callback acceptance are separate facts. A local decision response does not prove that native execution continued.

The tests exercise explicit permission decisions, stale identity rejection, bounded buffers and failure paths. Drivers must preserve the active native execution fence after an uncertain mutation. Overflow and disconnect must be visible to the application; they cannot imply successful completion or permit an overlapping turn.

## Next evidence

The operational store and supervisor must persist critical facts before publication, own ingestion independently of renderer subscriptions, and reconcile uncertain dispatch without resending a prompt automatically. Real SQLite tests establish transaction behavior, while worker replacement, actual Electron execution, load measurements and packaged tests remain separate gates.

Maintain the first release checklist in issue #178. Add exact command results and tested revisions to PR #179 as the slices are integrated. Do not infer native conformance or cross-platform support from compilation, simulated peers or a successful handshake.
