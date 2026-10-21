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
consumes the active scope. The Coach is the one exception: it has no filter of
its own — it reads the current scope as the _suggested default_ for its
answers, never a boundary.

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

Fixes shows copyable suggestions with the same supporting evidence. Copying
one does not mark it applied or effective. Watchtower does not edit setup
files, fetch repositories, or call a hosting service to verify PR delivery.

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

One chat surface with a single harness agent — the picker shows which
coding-agent CLIs are detected on your machine (Claude Code, Codex, OpenCode,
Gemini, …) and whether they are logged in. Detection is per ACP server: for
most agents the app drives the agent's own ACP-capable binary; for Codex,
Claude Code, and Pi the ACP server ships **bundled inside the app** (no extra
install — Claude Code and Codex only need their CLI login, Pi needs the base
`pi` CLI on PATH). Ask anything about your usage: the
agent answers from the same ledger the dashboard shows, queried live through
the in-app `watchtower-ledger` MCP server, and it says which window its
numbers cover (the current scope is its suggested default, never a boundary).

- **Skills are crafted conversationally.** Describe what you do and ask for a
  SKILL.md — or start from the **suggested-skill chips** on the welcome
  screen, which surface the patterns detected in your current window
  (frequency, spread, cost). A chip click is just a chat-starter: the agent
  authors the complete skill file, grounded in your real usage through its
  ledger tools, ready to copy and save.
- **Model and mode pickers** appear only when the selected harness declares
  them (progressive). Once probed, a harness's models and your picks are
  remembered, so switching back restores them instantly.
- A run streams live — thinking, tool calls with input/output previews, then
  the answer. **Copy** sits on assistant answers; **Regenerate** on the last
  one. **Stop** interrupts the running turn; **New conversation** (header)
  starts a fresh thread. Follow-up messages resume the same harness session.
- **Switching the harness mid-conversation asks first**: a switch starts a
  new conversation, so a confirmation dialog appears before the thread is
  cleared. Confirming stops any run in progress (the runner cancels all
  active runs, waits for their teardown, then deletes the old temp
  workspace), clears the thread and session, and restores the new harness's
  models/picks. On the welcome screen a switch is immediate — there is
  nothing to lose.

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
