# Coach & Skills runs on the Workspace stack as an ephemeral coaching chat

- Status: accepted
- Date: 2026-11-23
- Domain: agents (Coach & Skills), workspace (Projects, Tasks, Harness Connections)
- Supersedes in part: ADR 0017 (run channel and persistence), ADR 0019 (temp workspace, stdio server), ADR 0020
  (suggested scope window), ADR 0021 (chips send, per-harness model cache, briefing composition) and ADR 0022
  (API-key passthrough). Each affected ADR carries a blockquote naming the part it no longer governs.

## Context

Coach & Skills (ADRs 0017 to 0022) ran on its own harness runtime: `agent-harnesses/runtime.ts` over
`@mcpc-tech/acp-ai-provider` and the `ai` package, a coach coordinator, `coach:*` IPC and RPC, and renderer
`coach-skills/*` stores and components. The Workspace stack (ADRs 0039 to 0044) had since become the general
execution path: an AgentDriver registry, an ExecutionService, a WorkspaceStore with recovery, Delegation, side chats,
browser control, and the Workspace composer, timeline, requests and Harness Connections. Keeping both meant two
pickers, two sign-in and API-key paths, two cancellation and recovery models, and a coach chat whose session state
outlived the process without the recovery the Workspace store provides.

The coach still needs three things that Workspace does not give a chat by default: a conversation with no project
folder, the read-only ledger endpoint (ADR 0046), and a coaching stance. The No-project scratch project already
solves the first with a managed checkout that is not a user Project.

## Decision

### 1. The Workspace stack is the only harness path

Coach & Skills runs on the AgentDriver registry, ExecutionService, WorkspaceStore and the Workspace renderer
components: composer, timeline, requests, `WorkspaceAgentPicker` and Harness Connections. The legacy coach runtime,
the coach coordinator, the `coach:*` IPC and RPC, and the coach-only renderer components are removed, and both
`@mcpc-tech/acp-ai-provider` and `ai` are dropped as dependencies.

### 2. An ephemeral chat under a hidden Coach project

- The chat is a Task in an internal Project with the fixed id `workspace-coach-project`, marked `isCoach`, with the
  fixed checkout id `workspace-coach-checkout`. Its checkout is a managed, git-initialised directory under the app
  profile, created by `ensureManagedChatProject` exactly as the No-project scratch project is.
- The Project never appears in Project pickers, Task or Project listings, search, delegation capabilities or side
  chats. A Coach Task cannot have side chats.
- There is exactly one live Coach Task. It survives navigation between sections.
- New chat interrupts every active Run of the Task and waits for them to end, then purges the Task. The purge is
  fail-closed: a purge that cannot finish is reported as a failed discard, not as a fresh chat. The purged events
  become tombstones, so the workspace event feed stays contiguous.
- Opening the Workspace host runs a startup sweep that purges any Coach chat left by an earlier process.
- A Coach chat is never resumed after a restart.

### 3. Coach Tasks get the ledger endpoint only

A Coach Task attaches only the `watchtower-ledger` endpoint. It has no orchestration endpoint, so it cannot start
Delegated Tasks, and no browser endpoint. A native Delegated agent that the harness starts itself stays allowed
(ADR 0042). The ledger tools run without an approval prompt in every access mode, because every tool on that server
only reads. Claude and Codex approve the ledger server as a whole, through `allowedTools` and the server's
`default_tools_approval_mode`. ACP approves by tool name, and only while the ledger endpoint is attached to the
session: a title or elicitation that merely resembles a ledger tool, or that names another server such as
`watchtower-ledger-evil`, still asks like any other tool.

### 4. Coaching stance by endpoint, no scope injection

- The coaching and skill-authoring guidance is `ledgerInstructions`, keyed to the ledger endpoint and delivered by each
  driver the way `orchestrationInstructions` is (ADR 0044): once per agent session, when the endpoint is attached, in
  the variant for the harness behind it.
- The Analytics scope (period and provider) is not injected into the instructions or the Run. The ledger tools are
  stateless and default to the lifetime window, and the user names any other window in the conversation. This
  replaces the suggested-default window of ADR 0020.

### 5. Harness and model selection as in Workspace

- Selection uses the Workspace `WorkspaceAgentPicker` and Harness Connections. Remembered model and mode picks are
  shared between Workspace and Coach. The per-harness Coach model cache (ADR 0021, section 4) is removed.
- The API-key passthrough toggle (ADR 0022, decision 3, `allowApiKeyEnv`) is removed. API-key handling follows the
  Workspace Harness Connection.
- Switching harness takes effect on the next message. That message starts a new Agent Session on the new Harness
  Connection with a bounded handoff of the chat so far (ADR 0042), as in Workspace. There is no confirm-and-clear step.

### 6. The Coach-only UI that remains

- Suggested-skill chips on the empty state seed the composer with the skill-crafting prompt. They never send it.
- Save… on an assistant message saves its text as a skill file through `skills:save`.
- Folder-bound Workspace features are hidden in a Coach chat: the checkout strip, @file mentions, the terminal, the
  details panel, the file preview, diff, review, browser and pull-request panels, and side chats.

## Consequences

- One harness runtime, one connection and sign-in model, and one cancellation, recovery and event path for every
  chat. The legacy runtime and its two npm dependencies go away.
- Coach history is not kept. A restart or New chat ends it. A user who wants to keep a conversation uses a
  Workspace Task.
- The Coach project's checkout is app-managed internal state. It is not a user Project and never appears as one.
- Only the ledger MCP is read-only, and it stays so. A Coach Task has no orchestration and no browser endpoint. The
  agent's own tools (shell, file edits) follow the access mode chosen in the composer, exactly as in Workspace, and
  work in the app-managed Coach checkout.
- Chips change from ADR 0021: the user reviews the seeded prompt and sends it, so no run starts from a click alone.
- A Coach answer names the window it covers from what the user asked. A user who names no window gets lifetime totals.
- Skill files are written by Watchtower only when the user saves one through the native save dialog. Nothing in the
  Coach stack writes into a user folder on its own. The agent's own file tools act in the Coach checkout, under the
  access mode the user chose.

## Alternatives rejected

- Keep the legacy coach runtime and port only its UI. This keeps two harness stacks and two sign-in paths.
- Make the coach chat an ordinary Task in a visible Project. It would then appear in listings, search and delegation,
  and need its own retention rules. The hidden Project keeps it out of all of them.
- Resume coach chats across restarts. The chat is a working analysis, and resuming it would add state the startup
  sweep would have to recover, with no user-facing need.
