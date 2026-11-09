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
Workspace and Analytics are separate application verticals. Workspace opens by
default, including after reload, and loads the Project navigator. The sidebar header
uses the `sidebar-07` application switcher. Workspace owns the Project/Task
navigator in the shared sidebar; it has no second navigator inside the content
area. The existing Workspace route bypasses the Analytics dashboard layout.

- Keep the shared sidebar collapsible and responsive in both verticals. Scope
  numbered Section shortcuts, refresh and the command palette to Analytics;
  keep the registry-owned sidebar toggle available in both verticals. Workspace
  is selected by the application switcher rather than a numbered shortcut.
- Store the selected vertical and last resolved Analytics destination in the
  window's Atom registry. Switching back restores the destination, including
  session source identity. Router navigation stays authoritative. Workspace
  Project/Task/Conversation selection remains shared and locally persisted.
- The workspace navigator groups Tasks under Projects. Expand Conversations
  when a Task has several; keep the common one-Conversation case simple.
- Show title, activity, unread/attention state and pin/archive actions in compact
  rows. Internal identifiers belong in details, not the primary labels.
- Register/open a repository through a header action and dialog. Put editable
  Project metadata and connection setup in contextual settings. Registration
  forms must not permanently occupy the working area.
- Put the Project picker in the new-chat heading. Search and select Projects,
  add a Project from the same popup, or start without a Project through the
  secondary action beneath the heading. Changing this choice preserves typed
  input. The shared registration dialog offers the native folder chooser and
  retains a manual path field. Selecting a connection checks that connection;
  an extra inspection step must not obstruct the first message.
- New chat opens a focused composer with a Project picker, including No project.
  Opening the draft creates no Task. Its first submission creates the Task and
  Conversation, then dispatches the captured prompt. No project uses a persistent
  application-owned checkout and hides its internal Project from repository
  choices. Preserve the draft if creation or dispatch
  fails. If Task creation commits before Run dispatch fails, keep the Task and
  show the failure there; do not silently create duplicates on retry.
- One top header shows Project and chat title, including New chat. Its actions
  toggle the terminal, right panel and Agent run details. The new-chat welcome
  keeps its central Project picker, No project choice and existing draft.
  Checkout controls stay beside the composer; detailed execution state opens
  from the header.
- On smaller windows, open navigation and inspector as dismissible panels while
  retaining the conversation and input area. Resize panes within minimum sizes.

### Vertical navigation checkpoint

Workspace now opens by default. The shared sidebar contains the application
switcher and the active vertical's navigator. Analytics owns its Section
shortcuts, command palette and scan status; the shared sidebar toggle works in
both verticals. Switching back to Analytics restores the last resolved route
and session source identity. Project/Task/Conversation selection uses shared
Atom state and the existing local persistence format. The collapsed switcher
keeps the logo inside its button with the original muted background.

Verification on Windows: 342 Vitest files passed, with 3,862 passing tests and
5 skipped; all 14 Electron tests passed. The targeted navigation tests also
passed after the default-vertical correction. All four TypeScript projects,
Effect diagnostics, formatting and build passed. ESLint reported zero errors
with existing repository warnings. The packaged verifier now follows the
default Workspace boot flow; installer certification was not rerun for this UI
correction. No native agent turn was started.

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
  Dispatch the FIFO head automatically after a confirmed completion and when an
  idle Conversation has a persisted queue. Keep cancel available. Stop and failed
  or uncertain delivery hold the queue until the user explicitly resumes it.
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

The right panel has persistent, reorderable tabs for browser pages, terminals,
files, diffs, pull requests, devices and side chats. Closing a tab releases its
owned resource; hiding the panel preserves it. Bulk close confirms all running
terminal groups before disposing any of them. Its stored width and maximized
state apply to wide windows; narrow windows use a sheet and retain the composer.

Browser tabs use sandboxed Electron WebContentsViews. Native pages hide behind
application dialogs and menus. Navigation, address editing, history, zoom,
mute, developer tools and screenshot annotations retain their tab identity.
Local development links from terminal output open in these tabs. File tabs
support bounded text and image previews, references, external editor opening
and reveal actions through server-resolved checkout paths.

Pull request tabs use the repository's GitHub CLI context. Reads have bounded
responses; comments, reviews and lifecycle commands require the repository
identity shown in the tab. Reviews and merges also validate the displayed head
revision. Device tabs discover installed local Android and iOS toolchains and
report actual capabilities before enabling input or simulator controls.

Side chats create an independent Task from an immutable parent conversation
snapshot. A persisted receipt binds retries to that snapshot. Embedded
composers keep independent query selections and inspection focus while sharing
the window's event subscription. The native agent receives the captured context;
the conversation transcript keeps the user's original message. Before its first
Run, a side chat can use the current checkout or create a new worktree when sent.
Parallel agents use separate worktrees; the existing checkout admission still applies. Bringing a
finished reply back appends it to the parent draft and leaves its execution
under the parent's controls.

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
   components. Use folder headers and nested chat rows, a New chat action and a
   Project/No project picker in the chat. Keep initial draft input distinct from
   dispatched work.
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

## Chat-first checkpoint, 2026-11-02

The default screen is a chat draft. The Project picker sits in its heading,
with searchable Projects, No project and Add project. The secondary action
starts without a repository. Both registration entry points open one Add project
palette: browse local folders (Create & Add / Init & Add for missing or non-Git
folders), create a new project with an optional private GitHub repository, or
clone from GitHub or a Git URL. Setup runs through the user's own `git`/`gh`
(ADR 0012 addendum) and is replay-safe under its command ID. Folder headers
expand independently in the sidebar; its compact Search and icon actions
replace the permanent setup controls.
Search explicitly covers loaded Projects and Tasks, with paging available for
the rest. Expanding a folder does not navigate away from the active chat.

The first message creates the Task and Conversation before dispatch. No project
uses a persistent managed Git checkout inside the application profile, with
ordinary checkout revalidation and exclusive-write admission. The internal
Project stays out of the picker. These chats currently share that checkout;
separate working trees remain part of the checkout work.

The pinned composer supports explicit native resume, queue/cancel, automatic
FIFO delivery and explicit resume for held queues,
capability-gated steering and Stop, exact approval options, and structured
questions. Only adapters that expose cancellation offer a question cancel
control. Ordinary launch records and native identifiers stay in collapsed
details. The audit and response history remain inspectable.

Start commands persist their immutable payload and original draft before RPC.
Typing can continue independently. Uncertain delivery survives navigation and
reload and exposes an explicit retry of the same command, while fresh work is
blocked for that Conversation. Retention bounds never silently discard an
unresolved command. Selected connection inspection opens no session or SQL
worker and does not claim account authentication. Model and mode facts remain
unknown or session-scoped when the adapter cannot establish a catalog.

The deterministic Electron journey covers Project selection, folder browsing,
first send, approval, queue cancellation/promotion, streaming restoration,
interruption and a No project chat. No paid inference is required. The Stop
journey exposed and fixed an execution deadlock: an observed active turn can be
interrupted while its submit call waits for completion, without fabricating
native acceptance.

Scroll restoration, older-page anchoring and measured long-history/streaming
budgets remain open. Git/diff, PTY, file inspection, preview, forks, attachments,
the Task status/archive board, Coach migration and authenticated driver
certification remain later work. This checkpoint does not complete M3.1 or #178.

## Implementation checkpoint, wave E

The compact navigator now moves repository registration and Task creation into
dialogs and restores Project/Task/Conversation selection. Conversation output is
projected into chronological assistant segments, thinking blocks, tool groups
and visible Run status notices. Recent activity loads first; older pages and
forward catch-up use separate cursors. Verified payloads replace visible chat
placeholders. The reader limits reassembly to 8 MiB and retains at most 16 full
payloads with a 16 MiB serialized JSON budget; released records offer reload.
These are configured size limits, not measured heap or responsiveness budgets.

Operational reads expose persisted Run context, native sessions and delivery
history. Queued and starting Runs get their Conversation/checkout identity from
retained dispatch intents before native session binding. Coverage reports
truncation. Worker protocol 8 rejects workers without backward paging semantics.

The composer and its native controls are still unimplemented. Scroll position
across Conversation switches is not restored. Rendering limits bound entries,
not the number of tool/text blocks within a turn; 10,000-message responsiveness,
older-page reader anchoring and sustained streaming remain measurement gates.
Git/diff, PTY and preview services remain part of the target rather than empty
inspector tabs.

### Native inspection prerequisite

Expose an explicit selected-connection inspection command. Catalog listing must
stay inert. Extract lazy driver loading from execution ownership so inspection
does not open the workspace SQL worker. A scoped inspection may initialize a
native protocol process, but must never submit a prompt or open a session just
to obtain a model list. Match immutable connection identity, bound initialize
and cleanup time, and preserve unconfirmed termination as an error.

Current driver contracts do not establish a complete connection-level catalog:

- ACP model/mode choices arrive with normal session creation or loading.
- The current native Codex slice initializes the app server but implements no
  model-list operation. Empty model/mode arrays do not prove an empty catalog.
- The Claude adapter checks API-key presence before session creation. Presence
  does not validate a credential; successful initialization is a later native
  session fact.

Represent unknown, unavailable and observed session-scoped facts separately.
Successful protocol initialization must not be labeled as account
authentication. Publish capability evidence and model/mode facts as they become
available through normal execution. Ordinary tests use deterministic drivers;
no authenticated native turn was exercised by the seeded history fixture.

## Composer context checkpoint, 2026-11-02

New chats and existing Conversations now share the prompt editor and compact
agent/model controls. The input grows with its content, preserves IME input,
continues Markdown lists on Shift+Enter and keeps send, queue, steering and Stop
beside the selected agent. Agent choices are remembered by connection; a
Conversation retains its own model and mode choices. The model picker is also
available through `/model` and Mod+Shift+M.

Follow-ups keep their captured checkout, connection, model, mode, access and
attachment choices. The worker advances one FIFO item after cleanup confirms a
completed turn. Stop, failure, uncertain delivery or unconfirmed cleanup holds
the queue; only held queues show an explicit Resume action. On workspace open,
the worker checks bounded persisted queue heads and resumes eligible completed
queues without loading every Task. A failed or unavailable session never silently
starts a different native session.
Dispatch keeps an existing Agent Session's durable identity when loading its
native context, so resumed approval requests do not inherit a new provisional
identity and fail membership checks.

The file picker, clipboard image paste and file drop create attachment snapshots.
Images offer a preview and every attachment can be removed before submission.
The current limit is eight attachments and 4 MiB combined per message. Oversized
input is rejected. Original files are never truncated. Text files are sent as
context, supported images use native content blocks, and other files remain
available to native tools at a captured application-owned path. This does not
promise extraction or preview of every binary format.

`@` searches tracked and nonignored untracked checkout files and folder paths.
Selecting a file captures its bytes; selecting a folder captures a bounded file
listing. References cannot read through a link outside the selected checkout.
`/` searches the selected driver's native slash commands and skills for the
active checkout, plus checkout-local commands. `$` searches provider skills;
checkout skills fill gaps only when the provider catalog is incomplete.
Selecting a provider skill or command inserts its inline `$skill` or `/command`
token without creating an attachment. Checkout-local skill and command
instructions stay hidden from the attachment strip, and deleting their token
removes the associated context. `/attach` opens the file picker. Menus support
arrows, Enter, Tab and Escape. Slash commands are offered only at the start of
the prompt; skills remain available anywhere.

Attachment metadata survives draft navigation and reload. Start, queue,
promotion and steering intents retain snapshot references; receipt fingerprints
include them. A queued message still reads its original snapshot after its
source changes. SQLite migration 9 retains transcript/dispatch references and
session capability facts. Worker protocol 9 rejects an older worker that would
drop this data. Content hashes are checked when resolving saved snapshots.

Connection inspection can list native models and their effort choices without
creating a native conversation. Session-specific model/mode facts and advertised
commands come from authoritative native-session reads. Unknown capability facts
do not enable an action. The deterministic Electron journey exercises file
references, project skills, file upload, image paste/preview, draft file drop and
restoration, queue promotion with changed source content, approvals and Stop.
Driver fixtures cover native image/document blocks and model/effort routing.

Verification during this wave: all 351 Vitest files passed, with 3,939 passing
tests and five skipped; the full Electron suite passed 16/16. The later native
continuation correction passed the focused store, execution, worker and composer
checks and the Electron composer journey again. All four TypeScript projects,
Effect diagnostics, formatting and the production build passed. ESLint reported
zero errors with the repository's existing warnings. No paid inference or
authenticated native turn was started. Packaging was not rerun.

This checkpoint does not certify authenticated native turns, arbitrary binary
extraction, every provider's permissions/plan controls or the remaining M3.1
interaction gates. Keep #178 and draft #179 open.

## Provider prompt catalog checkpoint, 2026-11-09

The composer now follows the same suggestion model as the reference workspace.
`@` ranks checkout files and folders, inserting a Markdown file link. `/` shows
built-in actions, provider slash commands and skills; provider skills render as
`/skill:<name>` and insert their inline `$skill` token, while checkout-local
skills keep their captured instructions hidden from the attachment strip. `$`
searches provider skills directly, with checkout skills filling gaps only when
the provider catalog is incomplete. Commands stay limited to the start of the
prompt; skills remain available anywhere. The Tiptap editor renders mentions and
skills as atomic chips, keeps cursor positions stable across normalization and
draft restoration, and preserves IME input and Shift+Enter list continuation.
Menu rows share the fuzzy ranking helper, support arrows, Enter, Tab and Escape,
and restore the dismissed trigger only after the caret leaves it.

Verification on Windows: the full Vitest suite passed 395 files with 4,438
passing tests and 6 skipped. All four TypeScript projects, ESLint on the changed
files, Prettier and the production build passed. The Electron workspace journey
passed, covering `@` file references, `$` skills, `/` commands, draft
restoration, attachments, queued follow-ups, approvals and Stop; the model
options journey also passed. No paid inference or authenticated native turn was
started.
