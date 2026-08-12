# Using Watchtower

This guide covers day-to-day use: keyboard shortcuts, the period and provider
scope that every view shares, and what each of the nine sections shows in
detail.

## Keyboard shortcuts

Shortcuts are declared once in the shortcut registry
(`src/renderer/src/app/shortcuts.ts`, ADR 0001), which drives both their
registration and every place the UI renders them. `Mod` resolves to `⌘` on
macOS and `Ctrl` on Windows and Linux.

| Shortcut | Action |
|----------|--------|
| `Mod+1` | Overview |
| `Mod+2` | Sessions |
| `Mod+3` | Pull requests |
| `Mod+4` | Spend |
| `Mod+5` | Optimize |
| `Mod+6` | Models |
| `Mod+7` | Compare |
| `Mod+8` | Coach & Skills |
| `Mod+,` | Settings |
| `Mod+R` | Refresh |
| `Mod+B` | Toggle sidebar |

## Scope: period and provider

Every section shares the same **period switcher** (Today, 7D, 30D, Month, 6M,
Life, or a custom date range) and **provider filter**, and every data fetch
consumes the active scope. The Coach is the one exception: it has no filter of
its own — it reads the current scope as the *suggested default* for its
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

Sixteen store-driven detectors scan your sessions for waste and rank findings
by urgency:

| Detector | What it catches |
|----------|-----------------|
| `redundant-rereads`, `read-edit-ratio`, `build-folder-reads` | Re-reading the same files, editing without reading, junk directory reads |
| `warmup-heavy` | Excessive cache warm-up on short sessions |
| `mcp-low-coverage`, `mcp-project-scope`, `mcp-deferral-off`, `mcp-alwaysload-hygiene`, `mcp-defer-threshold` | MCP servers paying overhead without being used |
| `retry-heavy-capabilities` | Tools or capabilities with unusually high retry rates |
| `unused-agents`, `unused-skills`, `unused-commands` | Definitions that are never invoked |
| `low-worth-sessions`, `context-heavy-sessions`, `cost-outliers` | Sessions that spent heavily with little to show |

Each finding includes an estimated token or dollar saving and a ready-to-paste
fix.

> [!NOTE]
> The Optimize section is **read-only by design**: it diagnoses and advises
> but never edits your setup. The **Yield** tab runs live git queries (only
> when opened) to classify session spend as *productive*, *reverted*,
> *abandoned*, or *ambiguous* using timestamp-window attribution.

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
Gemini, …) and whether they are logged in. Ask anything about your usage: the
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
  (config survives), and a manual "Check for updates" (never automatic, never
  auto-installs)
