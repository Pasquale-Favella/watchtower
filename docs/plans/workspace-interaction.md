# Agent workspace interaction plan

Part of #178 and draft #179. This plan defines the interaction target for M3,
including the changes needed to replace the initial forms and event reader.
The execution, persistence and RPC invariants in ADR 0039 continue to apply.

## Research method

Inspect implementation paths for navigation, conversation rendering, composer,
requests, checkout changes and restoration. Treat screenshots as layout evidence
only. Sample-data screenshots do not prove native execution. Keep the private
source inventory, revision IDs and inspection notes outside published project
documentation. Describe adopted behavior here in Watchtower's domain language.

The current implementation proves durable reads and command transport. It does
not yet provide the intended coding experience. Passing its current tests does
not complete M3.1 or establish interaction parity.

## Primary layout

The active Conversation owns the viewport. Use a compact Project/Task navigator,
a flexible chat column and an optional changes inspector. A terminal drawer
belongs to the current checkout. Avoid a second page scrollbar around the chat.
The existing Workspace route already bypasses the analytics dashboard layout.

- Keep application navigation collapsible and preserve existing shortcuts.
- The workspace navigator groups Tasks under Projects. Expand Conversations
  when a Task has several; keep the common one-Conversation case simple.
- Show title, activity, unread/attention state and pin/archive actions in compact
  rows. Internal identifiers belong in details, not the primary labels.
- Register/open a repository through a header action and dialog. Put editable
  Project metadata and connection setup in contextual settings. Registration
  forms must not permanently occupy the working area.
- New Task opens a focused composer. Preserve its draft if creation or dispatch
  fails. If Task creation commits before Run dispatch fails, keep the Task and
  show the failure there; do not silently create duplicates on retry.
- The conversation header shows Task title, checkout/branch and current state,
  with actions for changes, terminal and Task details. Controls must read real
  state; do not add decorative tabs for unimplemented services.
- On smaller windows, open navigation and inspector as dismissible panels while
  retaining the conversation and input area. Resize panes within minimum sizes.

## Conversation and composer

Render user messages and assistant turns, not one card per storage event.
Project durable events into ordered text blocks, thinking summaries where the
driver provides them, tool groups, request cards and final outcomes. Preserve
native block identity and event order. The event log remains available in
details for inspection and recovery.

Group text deltas into their message and tool updates into their invocation.
Collapse completed routine tools; expand errors and actionable requests. A
tool's output must retain its lifecycle and provenance. Do not infer Task
completion from a completed assistant turn.

Use the generic MessageScroller primitives for height constraints, reader
position and jump-to-latest. Incoming tokens must not pull a reader away from
older messages. Paging older content preserves the visible anchor. Long
records retain verified chunked retrieval and explicit loading/error states.

Keep the composer pinned below the transcript in empty, busy, waiting, failed
and reconnecting states. It contains the prompt and supported attachment/context
actions, plus connection, model, effort/mode and checkout choices. Unsupported
and unknown capabilities must remain distinct. Availability of an executable
does not establish authentication or support for a control.

- Idle submission creates a new Run. Resuming a native session is an explicit,
  validated choice of session, connection, checkout and generation.
- Keep writing possible during execution. Enter sends while idle and queues a
  follow-up while busy; Shift+Enter adds a line. Provide a separate labeled
  steering action and keyboard binding when negotiated support exists.
- Show queued prompts above the composer with their order and delivery state.
  Support cancel and explicit dispatch through existing commands. Editing and
  reordering require new durable commands before their UI can be enabled.
- Stop targets the active Run. Navigating away, hiding a panel or disconnecting
  the renderer never stops application-owned execution.
- After an uncertain delivery, preserve the input and explain the unresolved
  state. Reconnect may replay the same command receipt; it must not create a
  fresh attempt automatically.

## Approvals and questions

Show approval summaries immediately above the composer, with expandable tool,
path and scope details. Present the exact native options; a generic Allow/Deny
mapping must not widen their meaning. No option is selected by default.

Render questions as structured cards with the actual options, free-text and
cancel semantics supported by the driver. Preserve input while a response is
pending. Persist and display response delivery as pending, accepted, failed or
uncertain, independently of whether the request later resolves.

Request identity includes Run and generation. Disable obsolete request cards;
never apply a stale answer to a newer Run. Bulk decisions require an explicit
selection of requests with compatible semantics. They are not the initial
default interaction.

## Changes, terminal and checkout context

The inspector lists actual changed files for the selected checkout, with
staged/unstaged state and bounded diff reads. Support unified/split review,
file selection, staging and commit through native services. Show attribution
confidence separately from the working-tree diff; external edits may exist.

The terminal is a contextual drawer backed by a main-owned PTY. Switching Tasks
must not send input to the previous checkout. Reopening a drawer preserves its
owned terminal where supported; closing a pane and terminating a process are
separate actions. Browser preview and file inspection use the same explicit
checkout context and isolated resource ownership.

Worktree selection must resolve and revalidate real paths. Concurrent writers
use existing exclusive-write admission or separate worktrees. A worktree is not
a filesystem sandbox. Do not offer destructive restore/rollback until its
changes and conflict semantics can be reviewed explicitly.

These services are part of the operational workspace target. A shell with empty
inspector tabs or fake terminal output does not satisfy that target.

## Restoration and shared state

Persist the selected Project/Task/Conversation, drafts keyed by Conversation,
panel sizes, panel selection and navigation preferences. Revalidate stale
selections against authoritative reads after relaunch; offer a useful fallback
when a Project is archived or a checkout is missing. Define bounded retention
and deletion for local drafts.

Read the current Run, native sessions, pending requests, queue and response
delivery history before enabling controls. Use a snapshot watermark followed by
events to avoid gaps and duplicates. Recent bounded renderer event retention
cannot replace authoritative operational reads after reload.

Keep Effect Atom/RPC as the renderer state boundary. One window subscription
updates read projections; components do not own native processes. Commands
capture immutable user intent and reuse their ID for transport retries. Server
state remains authoritative over optimistic UI and persisted navigation state.

Reuse generic presentation primitives from existing chat UI. Do not import
Coach-specific message state, retry semantics or agent ownership into Workspace.
Coach's later migration consumes the common execution engine.

## Implementation order and ownership

1. **Read and capability contracts.** Expose bounded Task snapshots and native
   session reads already present in the worker; wire response/steering history
   into renderer queries. Add negotiated capability/model/mode discovery with
   explicit resource ownership, authentication errors and cleanup. Keep catalog
   listing inert. Own shared contracts, handlers, read hooks and their tests.
2. **Shell and navigation.** Replace permanent forms with compact navigation and
   dialogs; persist selection/drafts/panes. Own WorkspaceView and navigation
   components. Keep initial draft input distinct from dispatched work.
3. **Turn projection and controls.** Group the durable transcript into messages
   and tool activity. Wire pinned composer, requests, queue, stop/resume and
   recovery to the contracts above. Own transcript/composer/request components
   and pure projection helpers. Integrate with the shell after both slices land.
4. **Checkout review and developer tools.** Implement real Git status/diff and
   actions, PTY, file inspection and isolated preview behind contextual panels.
   Own native service contracts and the corresponding inspector/drawer views.
5. **Interaction verification.** Exercise the complete user journeys in Electron
   and the packaged app, then update M3 acceptance evidence. Do not declare
   completion from screenshot similarity or helper tests alone.

For each wave, use disjoint implement slices, then Standards/Spec review and a
scoped simplification pass before integration. Publish results in the existing
issue, PR and living plan rather than a second planning thread.

## Acceptance evidence

- Open a repository, create a Task and submit work from the composer with no
  separate setup form obstructing the conversation.
- Switch between active Tasks while preserving drafts, scroll position and
  checkout context. Tool output is grouped and the composer stays visible.
- Answer real structured requests through deterministic protocol fixtures;
  prove stale-generation rejection, failed delivery and uncertain delivery UI.
- Queue/cancel/dispatch follow-ups while a Run is active. Prove steering and
  interrupt visibility follows negotiated capability evidence.
- Reload during streaming and while awaiting approval. Reconstruct state from
  durable reads and resume events without duplicate messages or new dispatch.
- Page a 10,000-message history, open a large payload and preserve reader anchor
  and bounded rendering. Measure responsiveness and backlog rather than relying
  on a fixed batch interval alone.
- Review actual Git changes, use a checkout-scoped terminal, and switch worktrees
  without misrouting input or attributing external changes to an agent.
- Verify keyboard focus, labels, resize limits and a narrow window with the
  actual rendered application. No invisible actionable controls.
- Run ordinary CI without paid inference. Keep authenticated native turns,
  packaging/authentication certification and cross-platform evidence as explicit
  release gates.
