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
The app's top-level screens — overview, sessions, pull requests, spend, optimize,
models, compare, coach & skills, settings. The sidebar and the numbered shortcuts
navigate between them.
_Avoid_: page, tab

**Command palette**:
The single keyboard-driven launcher (`Mod+K`) listing Sections and Actions.
Global search is a future row source, not a synonym for the palette.
_Avoid_: global search, quick switcher, command menu

**Command**:
One row in the command palette — either a Section or a registry Action.
_Avoid_: shortcut, action

**Coach & Skills**:
The unified chat section (ADR 0017): one surface where a single harness agent
serves two scopes — coaching analysis and skill authoring — grounded in the
ledger through the in-app `watchtower-ledger` MCP server (ADR 0020). Skill
crafting is conversational; the detected-pattern chips on the welcome screen
are plain chat-starters (ADR 0021).
_Avoid_: coach section, skills section

**Project**:
A registered local work context with a stable repository identity. Its name,
path leaf or remote URL alone does not identify it.
_Avoid_: repository name

**Workspace Checkout**:
A concrete working tree or directory for a Project. A main checkout and a
worktree are distinct checkouts.
_Avoid_: workspace folder

**Task**:
The user's objective and its delivery lifecycle, independent of any one agent
attempt. Completing an attempt does not complete the Task.
_Avoid_: run, prompt

**Conversation**:
An ordered discussion associated with a Task. A Task may have multiple
Conversations, including forks.
_Avoid_: session

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

**Driver Connection**:
A scoped runtime resource for protocol IO and process resources. Its lifetime
may serve one or more native Agent Sessions when the driver supports it.
_Avoid_: Agent Session

**Agent Run**:
One attempt to submit work through an Agent Session. A retry is a new Run;
finishing a Run does not establish Task delivery.
_Avoid_: session, conversation

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

- The README's platform claim (Windows | macOS | Linux) is the product
  promise; packaging config must never regress below it (ADR 0015).
- Providers auto-detect from local files and never require API keys (ADR 0012).
