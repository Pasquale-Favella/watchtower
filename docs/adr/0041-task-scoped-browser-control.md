# Task-scoped browser control

Status: accepted.

## Context

Workspace already owns sandboxed Electron browser tabs, screenshot annotation,
and persistent browser sessions. Agent Runs need to inspect and interact with
the same pages the user sees.

The application and browser pages share one main process. Browser automation
can use Electron's debugger directly without a separate browser broker.

## Decision

The preview manager owns native pages and their Task bindings. Renderer RPC
binds a panel resource owner to an existing Task. Draft resource keys survive
Task creation. Owner-scoped tab streams synchronize pages created or closed by
an agent with the right panel.

`ExecutionService.prepareSession` acquires browser access within the Driver
Connection scope. The resulting session context contains an ephemeral MCP
transport descriptor. It never enters workspace persistence. Each dispatch
has its own random credential and loopback endpoint. Closing its scope revokes
access, cancels pending interactions, and releases automation resources while
retaining browser pages.

Codex, Claude and ACP adapters configure their native MCP integration from this
descriptor. The endpoint derives Task and Agent Session identities from the
dispatch context. Tool arguments cannot change them. Reads can inspect any tab
in that Task. Writes claim an unclaimed tab or require the same Agent Session.
The user can pause writes and cancel pending operations. Element picking pauses
agent writes before inspecting the page.

The Electron adapter uses CDP for accessibility inspection, trusted keyboard
and pointer input, evaluation, uploads, dialogs, viewport emulation and page
diagnostics. Element references expire on navigation or a fresh snapshot.
Browser pages keep sandboxing, context isolation and the HTTP(S) navigation
policy. No remote debugging port exposes application windows.

Shared Effect Schemas define tool arguments and renderer RPC contracts. The
official MCP SDK owns protocol negotiation and HTTP framing. The existing
authenticated MCP HTTP adapter serves both ledger and browser capabilities.
Effect owns endpoint acquisition and finalization through the main runtime.
Promise APIs remain at Electron and MCP SDK callback boundaries.

## Consequences

- Agents and users operate on the same native browser tabs. Hidden tabs remain
  available without selecting another Task in the renderer.
- Uploads resolve real paths and must stay within the active Workspace Checkout.
  Diagnostics, snapshots, screenshots, timeouts and recording buffers are bounded.
- The existing persistent browser profile remains shared across Workspace tabs.
  Task authorization separates tab control; it does not isolate cookies or site
  storage.
- Recordings use bounded CDP screenshot frames and export standalone HTML
  playback with capture timestamps. They do not require a platform video encoder.

Related: ADRs 0005, 0032, 0034, 0037, 0038 and 0039.
