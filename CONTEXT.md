# Watchtower

Desktop app for local code-assistant token and cost telemetry. Scans on-disk
session data of AI coding tools (providers) into a local SQLite ledger, then
serves query-time analytics views.

## Language

**Packaging target**:
The installer formats the app is built into for an operating system — Windows
NSIS, macOS DMG/zip, Linux AppImage/deb.
_Avoid_: platform build, distributable

**Artifact**:
A packaged installer produced by the build pipeline. One per packaging target.
_Avoid_: build output, installer

**Release**:
A version tag (`v0.x.y`) on the repo whose artifacts are published as a
GitHub Release with all three packaging targets attached. Nothing is a release
until the tag exists.
_Avoid_: drop, build

**Sign-ready**:
A packaging configuration that signs artifacts when signing credentials are
present in the environment and skips signing cleanly when they are absent.
Sign-ready is not signed.
_Avoid_: code-signed

**Full Disk Access**:
The macOS TCC permission required for the app to read other applications'
data (provider session files). Without it, a scan finds zero sources on macOS
only; Windows and Linux have no equivalent gate. Code identifiers abbreviate
this as `fda` (e.g. `fdaNeeded`, `open-fda-settings`); prose should use the
full term.
_Avoid_: disk access, permissions

**Scope**:
The active filter for analytics views — a period (or custom date range) plus an
optional provider filter; every data fetch consumes it.
_Avoid_: filter settings, date range

**Section**:
An Analytics screen: overview, sessions, pull requests, spend, optimize,
models, compare, coach & skills. The Analytics sidebar and its shortcuts
navigate between them.
_Avoid_: page, tab

**Application vertical**:
One of the app's two working areas, Analytics or Workspace. The sidebar switcher
selects the vertical and its navigation. Workspace groups Projects and Tasks;
Analytics groups Sections.
_Avoid_: workspace section

**Command palette**:
The single keyboard-driven launcher (`Mod+K`) listing Sections and Actions.
Global search is a future row source, not a synonym for the palette.
_Avoid_: global search, quick switcher, command menu

**Command**:
One row in the command palette — either a Section or a registry Action.
_Avoid_: shortcut, action

**Coach & Skills**:
The unified chat section (ADR 0017): one ephemeral chat with a single harness agent that serves two
scopes, coaching analysis and skill authoring, grounded in the ledger through the read-only
`watchtower-ledger` MCP endpoint (ADRs 0020, 0046). The chat runs on the Workspace stack under a hidden
**Coach project** (ADR 0045). It survives navigation and is discarded by New chat or at the next startup.
Skill crafting is conversational; the detected-pattern chips on the empty state seed the composer rather than
sending (ADR 0021, ADR 0045).
_Avoid_: coach section, skills section, coach workspace

**Project**:
A registered local work context with a stable repository identity. Its name,
path leaf or remote URL alone does not identify it.
_Avoid_: repository name

**Workspace Checkout**:
A concrete working tree or directory for a Project. A main checkout and a
worktree are distinct checkouts.
_Avoid_: workspace folder

**No project**:
A chat using the application's persistent managed checkout rather than a
registered user repository. Its internal Project keeps execution and recovery
identities valid and stays out of the user Project picker.

**Coach project**:
The hidden internal Project under which the single live **Coach & Skills** chat runs. Like **No project**, it
has a managed checkout under the app profile. It never appears in Project pickers, listings, search, delegation or
side chats.
_Avoid_: coach workspace, temp workspace

**Task**:
The user's objective and its delivery lifecycle, independent of any one agent
attempt. Completing an attempt does not complete the Task.
_Avoid_: run, prompt

**Conversation**:
An ordered discussion associated with a Task. A Task may have multiple
Conversations, including forks.
_Avoid_: session

**Side chat**:
An independently addressable Task and Conversation linked to a parent
Conversation at a fixed point in its history. Unlike a Delegated Task, a side chat is started by the user and seeded from a fixed parent snapshot.
is hidden from Task listings, and is opened from the parent's right panel.
Bringing it back queues its history for the parent's next Run (ADR 0043).
_Avoid_: reply branch

**Context handoff**:
Prior Conversation context supplied when the next Run changes Harness
Connection and starts a new Agent Session in that same Conversation.
_Avoid_: session resume

**Harness**:
A coding-agent tool the app drives through a supported integration. A Harness
may expose multiple models and interaction modes; its integration protocol is
distinct from a telemetry Provider.
_Avoid_: provider (a provider is a telemetry source in the pipeline)

**Harness Connection**:
A named installation and authentication context for a Harness. It contains no
plaintext credential.
_Avoid_: Harness session

**Agent Session**:
A durable association to one native agent conversation and its driver,
connection and checkout context. It is not a process.
_Avoid_: run, subprocess

**Agent Goal**:
A persistent objective tracked by a Harness inside an Agent Session, with its
own status and usage accounting. It does not replace the Task's objective or
delivery lifecycle.
_Avoid_: task, run

**Driver Connection**:
A scoped runtime resource for protocol IO and process resources. Its lifetime
may serve one or more native Agent Sessions when the driver supports it.
_Avoid_: Agent Session

**Agent Run**:
One attempt to submit work through an Agent Session. A retry is a new Run;
finishing a Run does not establish Task delivery.
_Avoid_: session, conversation

**Delegated agent**:
A child agent a Harness starts natively during a Run, such as a Claude Agent call or a Codex collaboration call. Its native identity and progress belong to that Harness; it does not become a Watchtower Task.
_Avoid_: side chat, delegated task

**Delegated Task**:
A Task that an Agent Run starts through the orchestration tools, on any Harness Connection. It is a full Task with its own Conversation, Agent Sessions and Runs, linked to its parent Run by a Delegation. Settling a Delegated Task does not complete the parent Task.
_Avoid_: subtask, sub-agent, child run

**Delegation**:
The durable link from a parent Agent Run to the Delegated Task it started. It records the isolation, access mode, wake policy, status, result snapshot and whether the parent has read the result.
_Avoid_: handoff, spawn

**Delegation wake**:
A message queued into the parent Conversation when a Delegated Task settles. It carries the Delegated Task's result as data for the parent Agent to read.
_Avoid_: notification, callback

**Orchestration tools**:
The in-app MCP tools an Agent Run uses to list delegation targets, start Delegated Tasks, read their status and cancel them. The server is bound to one Agent Run by a bearer credential.
_Avoid_: agent tools, MCP tools

**Work Artifact**:
An output of managed work, such as a patch, report or handoff package. It is
distinct from an Artifact, which remains a packaged installer.
_Avoid_: Artifact

**Alias**:
A custom price that copies another model's prices: calls of an unrecognized
model are priced as if they ran on the mapped model.
_Avoid_: map to model, add alias

**Price override**:
A custom price entered manually as input/output rates for a model; it wins
over any other price source.
_Avoid_: manual price, manual

**Operational log**:
The append-only local record of app lifecycle and errors, containing no
prompts and no ledger facts.
_Avoid_: telemetry, diagnostics bundle, console log

**Associated spend**:
The spending within Scope for sessions supporting a finding or delivery outcome.
It does not establish how much of that spending was avoidable.
_Avoid_: wasted money, lost spend, savings

**Delivery outcome**:
The available evidence linking a session's work to changes on the inspected
main reference, including unknown or unmatched evidence.
_Avoid_: productivity verdict, abandonment

**Modeled opportunity**:
A pattern whose possible improvement depends on stated assumptions rather than
a measured reduction in spending.
_Avoid_: realized savings, guaranteed savings

## Rules

- A Delegated Task's Runs never exceed the access mode of the Run that started them.
- The README's platform claim (Windows | macOS | Linux) is the product
  promise; packaging config must never regress below it (ADR 0015).
- Providers auto-detect from local files and never require API keys (ADR 0012).
