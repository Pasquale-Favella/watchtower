# Using Watchtower

This guide covers day-to-day use: keyboard shortcuts, the period and provider
scope that every view shares, and what each of the nine sections shows in
detail.

## Keyboard shortcuts

Shortcuts are declared once in the shortcut registry
(`src/renderer/src/app/shortcuts.ts`, over the table in
`src/shared/lib/shortcuts.ts`, ADR 0001), which drives both their
registration and every place the UI renders them. `Mod` resolves to `⌘` on
macOS and `Ctrl` on Windows and Linux.

| Shortcut    | Action                                                      |
| ----------- | ----------------------------------------------------------- |
| `Mod+1`     | Overview                                                    |
| `Mod+2`     | Sessions                                                    |
| `Mod+3`     | Pull requests                                               |
| `Mod+4`     | Spend                                                       |
| `Mod+5`     | Optimize                                                    |
| `Mod+6`     | Models                                                      |
| `Mod+7`     | Compare                                                     |
| `Mod+8`     | Coach & Skills                                              |
| `Mod+,`     | Settings                                                    |
| `Mod+R`     | Refresh                                                     |
| `Mod+B`     | Toggle sidebar                                              |
| `Mod+K`     | Command palette                                             |
| `Mod+Alt+O` | Summon Watchtower (global — works with every window hidden) |

**Summon Watchtower** is the one OS-wide shortcut: the main process registers
it, so it works while Watchtower lives in the tray. With the app window on
screen it focuses the window; otherwise it floats the orb and unfolds its spend
panel (turning _Show floating orb_ back on if it was off); pressed again with
the panel open, it opens the full app.

## Scope: period and provider

Every section shares the same **period switcher** (Today, 7D, 30D, Month, 6M,
Life, or a custom date range) and **provider filter**, and every data fetch
consumes the active scope. The Coach & Skills chat is the one exception: it takes no scope
from these controls. It reads your full lifetime ledger unless your message names a window, and it says which window
its numbers cover.

## The nine sections

### Overview

Cost, calls, session count, input/output/cache tokens, savings, and estimated
cost at a glance, plus a zero-filled daily chart, top models, top activities
with per-category one-shot rates, tools, MCP servers, skills, and subagents.

The **efficiency grade** (A+ to F) is a single score combining:

- **One-shot rate**, the share of edit turns that succeeded without retries
- **Cache hit**, the share of input served from cache
- **Retry tax**, spend lost to retried edits, broken down per model
- **Routing waste**, what your spend would have cost on the cheapest reliable
  model, per model
- **Pricing coverage**, the share of calls priced from real data rather than
  $0 fallbacks

A **workflow** card reports correction rate, median time-to-first-edit, and
the most reworked files. Local-model usage (free models mapped to a paid
baseline) is tracked separately as savings.

### Sessions

Full history in a filterable table, by project, provider, period, or
free-text search across user messages and bash commands. Opening a session
shows its timeline: each turn's user message, classification, git branch, PR
refs, retries, and every assistant call with its model, speed, tools, MCP
tools, skills, subagents, and token/cost detail.

### Pull Requests

Sessions are correlated with the project's git history so spend lands on the
PR that shipped it, turn by turn, with the branch context each turn recorded.
Rows show per-PR cost, calls, sessions, and time span, and a PR opens in your
browser with one click.

### Spend

Two stacked daily charts (by model, by project) and a **Sankey flow** linking
the top models and projects by cost, with an "Other" rollup. The window is
zero-filled, so days with no recorded data are visible rather than silently
missing.

### Optimize

Waste groups findings into setup recommendations, habits, and information
for review. Each finding distinguishes observed counts from modeled quantities,
states its assumptions, and links to supporting sessions where available.
Expanding a finding also shows a copyable suggestion. Copying one does not
mark it applied or effective, and Watchtower does not edit setup files.
Associated spend shows those sessions' scoped cost. It does not establish
recoverable savings, so unsupported savings totals stay unavailable.

The findings cover file reads, read/edit behavior, cache warmup and reuse,
MCP configuration and usage, definition usage, rework signals, expensive
sessions, explicit tool failures, and interrupted calls. Claude-specific
setup checks require Claude observations. Delegated sessions retain their
spend and are excluded from standalone behavior comparisons. Setup health
uses eligible setup findings and shows insufficient evidence when coverage
cannot support a grade.

Outcomes runs local Git inspection when opened. It shows session spending
with matched main changes, reverted changes, mixed evidence, unmerged changes,
unmatched sessions, ambiguous attribution, or unknown inspection. Expand a row
for the matched SHAs, attribution window, and inspection details. Reverts
includes mixed sessions so surviving work remains visible.

Commit attribution uses the tightest containing session window, with a
one-hour allowance after the last recorded call. It is a heuristic. Research,
reviews, work in progress, delayed commits, and rewritten history can have
no matched delivery evidence. A missing repository or failed inspection stays
unknown. Outcome amounts are associated session spending, not proven losses.
Watchtower does not fetch repositories or call a hosting service to verify PR
delivery.

### Models

Per-model rows with cost, calls, tokens, and savings, switchable to per-task
and per-category breakdowns. An **audit** view exposes exactly where every
number comes from. Models the pricing data does not know get a `$0.00` row
plus an inline quick-add: type an alias or a price override and the affected
rows repaint instantly (no rescan; pricing is applied at query time).

### Compare

A model-pair picker over every model detected in the selected period, then a
side-by-side card of performance and efficiency metrics: one-shot rate, retry
rate, cost per call, cost per edit, output tokens per call, and cache-hit
rate, plus per-category one-shot bars and a working-style summary.

### Coach & Skills

A coaching chat with one harness agent. It answers from your usage ledger through the read-only `watchtower-ledger`
MCP endpoint, and it drafts skills in the same chat. The chat runs on the Workspace stack, so the composer, the harness
picker and Harness Connections work as they do in Workspace.

- **Pick a harness.** The picker lists the coding-agent CLIs detected on this machine (Claude Code, Codex, OpenCode,
  Gemini, …) and whether each one is signed in. Model and mode pickers appear only when the selected harness declares
  them. Your picks are shared with Workspace and remembered. If a harness needs an API key, set it up in its Harness
  Connection. There is no separate Coach switch for keys.
- **Ask about your usage.** The agent reads your full lifetime ledger. It uses the window you name in your message
  ("last 30 days", "Claude only") and states which window its numbers cover. The Analytics period and provider are not
  sent to it.
- **Only the ledger is read-only.** The ledger tools only read, so they run without an approval prompt: Claude and
  Codex approve the ledger server as a whole because every tool on it reads, and ACP agents approve by tool name while
  the ledger endpoint is attached. The agent's own tools (shell, file edits) follow the access mode you pick in the
  composer, as in Workspace, and work in an app-managed Coach folder, not in your projects. The coach chat has no
  orchestration tools, so it cannot start Delegated Tasks, and it has no browser. Subagents that a harness starts on
  its own still run as they do in Workspace.
- **Skills are crafted in the chat.** The suggested-skill chips on the empty state show the patterns detected in your
  current Analytics window, with their frequency, spread and cost. A chip fills the composer with a skill-crafting
  request. Review it and send. The agent drafts a SKILL.md grounded in your real invocations.
- **Save…** on an assistant message saves its text as a skill file through the system save dialog.
- **Streaming.** Answers stream live: thinking, tool calls, then the answer. **Stop** interrupts the running answer.
- **Switching harness** applies to the next message. That message starts a new session on the new harness with a
  bounded handoff of the chat so far. Nothing is cleared and no confirmation is asked.
- **New chat** (header) interrupts a running answer, then discards the chat and its history. The chat stays while you
  move between sections, but it is not kept across a Watchtower restart.
- Workspace features that need a project folder are hidden in the chat: the checkout strip, @file mentions, the
  terminal, the details panel, the file preview, diff, review, browser and pull-request panels, and side chats.

### Settings

A seven-pane rail (**General, Providers, Model aliases, Pricing, Export,
Skills detection, Privacy & data**):

- **General** sets the light/dark/system theme, background scan cadence
  (Manual, 30s, 1m, 3m, 5m, 10m), default period, and the Claude config
  directories the scanner aggregates
- **Providers** lists the tools detected on this machine and their data
  locations
- **Model aliases** map an unpriced or renamed model to a priced one
- **Pricing** sets input/output rates (USD per 1M tokens) for any model; the
  ledger stores raw tokens, so display cost recomputes on read
- **Export** writes full-history CSV or JSON in the currently selected display
  currency through a native folder/file picker
- **Skills detection** tunes the frequency × spread gate that decides when a
  repeated pattern in a window becomes a suggested-skill chip in the Coach
  section
- **Privacy & data** shows database and cache sizes, offers a full data wipe
  (config survives), and explicit update check, download, and restart-to-install
  controls. Unsupported installations offer a release-page link. See
  [app updates](releases.md).
