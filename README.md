<div align="center">

<img src="assets/watchtower-logo.svg" alt="Watchtower" width="96" align="left" />

# Watchtower

**Every agent. One dashboard.**

A **local-first desktop dashboard** that turns the session files your AI coding tools already write to disk into a clear picture of your **token usage and spend** — broken down by **tool, model, project, and task**, with efficiency signals (one-shot rate, retry tax, routing waste) and read-only optimization advice.

[![Version](https://img.shields.io/badge/version-0.1.0-1e3a8a?style=flat-square)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Electron 43](https://img.shields.io/badge/Electron-43-47848f?style=flat-square&logo=electron&logoColor=white)](package.json)
[![React 19](https://img.shields.io/badge/React-19-61dafb?style=flat-square&logo=react&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?style=flat-square&logo=typescript&logoColor=white)](package.json)
[![Node 22+](https://img.shields.io/badge/Node.js-22%2B-339933?style=flat-square&logo=node.js&logoColor=white)](package.json)
[![Windows | macOS | Linux](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square)](electron-builder.yml)
[![Local-first](https://img.shields.io/badge/privacy-local--first-success?style=flat-square)](#data--privacy)

</div>

Claude Code, Codex, Cursor, Copilot, Gemini, and 30+ more tools are read **straight from this machine**. Nothing is uploaded, nothing is proxied, and no API keys are needed: the app is the reader, your tools are the source of truth.

## Highlights

- **38 providers** detected automatically from their on-disk stores (SQLite / JSONL / JSON)
- **Incremental scans** — a background cadence ports only what changed, not full history
- **Accumulating ledger** — raw transcript facts in (SQLite), every view derived at query time
- **Sandboxed renderer** — all data stays in the main process; the UI receives shaped, schema-validated payloads over IPC
- **No telemetry** — the only network traffic is optional pricing and exchange-rate refreshes

---

## The eight sections

| Section | Shortcut* | What it shows |
|---------|-----------|---------------|
| **Overview** | `1` | KPIs (cost, calls, sessions, tokens, cache hit, savings), daily spend chart, top models/activities/tools, an A–F efficiency grade, workflow signals, and local-model savings |
| **Sessions** | `2` | Every working session, searchable and filterable — click any row to drill into a turn-by-turn timeline with per-call usage |
| **Pull Requests** | `3` | Spend attributed to each PR from real git history, so the cost of shipped work is trustworthy |
| **Spend** | `4` | Daily spend stacked by model and by project, plus a Sankey flow showing where money moves from models to projects |
| **Optimize** | `5` | Sixteen waste detectors with copy-paste fixes, an A–F setup-health grade, and a Yield tab for productive vs. reverted/abandoned spend |
| **Models** | `6` | Per-model cost, tokens, and calls, broken down by task and audited down to the token — with inline quick-add pricing for unpriced models |
| **Compare** | `7` | Pick two models and see one-shot rate, retry rate, cost per call, and cache-hit rate side by side |
| **Settings** | `,` | Theme, refresh cadence, default period, provider info, model aliases, pricing overrides, export, and privacy controls |

*\* Press `⌘`/`Ctrl` + the number (`⌘1`, `Ctrl+2`, …). `⌘R`/`Ctrl+R` re-scans on demand; `⌘B`/`Ctrl+B` toggles the sidebar.*

Every section shares the same **period switcher** (Today, 7D, 30D, Month, 6M, Life, or a custom date range) and **provider filter**.

### Overview

Cost, calls, session count, input/output/cache tokens, savings, and estimated cost at a glance — plus a zero-filled daily chart, top models, top activities with per-category one-shot rates, tools, MCP servers, skills, and subagents.

The **efficiency grade** (A+ to F) is a single score combining:

- **One-shot rate** — the share of edit turns that succeeded without retries
- **Cache hit** — the share of input served from cache
- **Retry tax** — spend lost to retried edits, broken down per model
- **Routing waste** — what your spend would have cost on the cheapest reliable model, per model
- **Pricing coverage** — the share of calls priced from real data rather than $0 fallbacks

A **workflow** card reports correction rate, median time-to-first-edit, and the most reworked files. Local-model usage (free models mapped to a paid baseline) is tracked separately as savings.

### Sessions

Full history in a filterable table — by project, provider, period, or a free-text search across user messages and bash commands. Opening a session shows its timeline: each turn's user message, classification, git branch, PR refs, retries, and every assistant call with its model, speed, tools, MCP tools, skills, subagents, and token/cost detail.

### Pull Requests

Sessions are correlated with the project's git history so spend lands on the PR that shipped it — turn by turn, with the branch context each turn recorded. Rows show per-PR cost, calls, sessions, and time span, and a PR opens in your browser with one click.

### Spend

Two stacked daily charts (by model, by project) and a **Sankey flow** linking the top models and projects by cost, with an "Other" rollup. The window is zero-filled, so days with no recorded data are visible rather than silently missing.

### Optimize

Sixteen store-driven detectors scan your sessions for waste and rank findings by urgency:

| Detector | What it catches |
|----------|-----------------|
| `redundant-rereads`, `read-edit-ratio`, `build-folder-reads` | Re-reading the same files, editing without reading, junk directory reads |
| `warmup-heavy` | Excessive cache warm-up on short sessions |
| `mcp-low-coverage`, `mcp-project-scope`, `mcp-deferral-off`, `mcp-alwaysload-hygiene`, `mcp-defer-threshold` | MCP servers paying overhead without being used |
| `retry-heavy-capabilities` | Tools/capabilities with unusually high retry rates |
| `unused-agents`, `unused-skills`, `unused-commands` | Definitions that are never invoked |
| `low-worth-sessions`, `context-heavy-sessions`, `cost-outliers` | Sessions that spent heavily with little to show |

Each finding includes an estimated token/dollar saving and a ready-to-paste fix. The section is **read-only by design** — it diagnoses and advises, it never edits your setup. The **Yield** tab runs live git queries (only when opened) to classify session spend as *productive*, *reverted*, *abandoned*, or *ambiguous* using timestamp-window attribution.

### Models

Per-model rows with cost, calls, tokens, and savings — switchable to per-task and per-category breakdowns. An **audit** view exposes exactly where every number comes from. Models the pricing data doesn't know get a `$0.00` row plus an inline quick-add: type an alias or a price override and the affected rows repaint instantly (no rescan — pricing is applied at query time).

### Compare

A model-pair picker over every model detected in the selected period, then a side-by-side card of performance and efficiency metrics: one-shot rate, retry rate, cost per call, cost per edit, output tokens per call, and cache-hit rate — plus per-category one-shot bars and a working-style summary.

### Settings

A six-pane rail — **General, Providers, Model aliases, Pricing, Export, Privacy & data**:

- **General** — light/dark/system theme, background scan cadence (Manual, 30s, 1m, 3m, 5m, 10m), default period, and the Claude config directories the scanner aggregates
- **Providers** — the tools detected on this machine and their data locations
- **Model aliases** — map an unpriced/renamed model to a priced one
- **Pricing** — set input/output rates (USD per 1M tokens) for any model; the ledger stores raw tokens, so display cost recomputes on read
- **Export** — full-history CSV or JSON in the currently selected display currency, written through a native folder/file picker
- **Privacy & data** — database and cache sizes, a full data wipe (config survives), and a manual "Check for updates" (never automatic, never auto-installs)

---

## How it works

```
tool stores on disk (SQLite / JSONL / JSON)
        │  discovery: probe known paths per provider
        ▼
   extraction  — provider parsers read foreign blobs into parsed call records
        │  sealed by a shared zod schema: unknown keys stripped, a declared
        │  field failing its type → the row is skipped and counted as
        │  "unparsed" — a provider schema drift degrades that provider,
        │  never the whole scan
        ▼
   session cache  — per-file fingerprints (dev/ino/mtime/size) reconcile what changed
        │
        ▼
   port-in  — per-file deltas stream into the ledger, upserted by a stable key
        │  (source_file, sessionId, dedupKey); re-ports are idempotent
        ▼
      ledger (SQLite)  — raw transcript facts, nothing materialized
        │
        ▼
   aggregation  — every view re-derives its totals at query time
```

### The ledger

The store is an **accumulating, normalized ledger** of four tables — `ledger_source`, `ledger_call`, `ledger_turn`, `ledger_session` — holding only what the transcripts observed: per-call facts with raw token counts and a base cost, per-turn classification, session facts, and per-source provenance.

Because scans port *deltas* instead of rewriting snapshots:

- The **first scan is lifetime** (epoch → now), so no file's history is ever stranded; later scans only touch files whose fingerprint changed
- A `modified` file is replaced atomically; a durable provider (one that union-merges) never loses pruned-span history
- Config changes (aliases, price overrides, currency) repaint views instantly — the ledger never stores a computed cost, only tokens + base price
- Five single-column indexes keep query-time aggregation sub-second on a full local history

### The extraction seam

Every provider's parsed call record flows through one shared zod schema (`src/shared/schemas/providers.ts`) before it can become a cached call or a ledger row. The same schema library is the single source of truth for ledger rows, IPC payloads, and view shapes — compiled into both the node and web tsconfigs. The renderer additionally validates each IPC payload on arrival as a cheap tripwire, rendering an error state rather than garbage.

Scan metadata carries per-provider **unparsed** counts, so a vendor's schema drift is visible in the UI instead of silently corrupting totals.

### The scan loop

The main process owns the pipeline. A manual `⌘R`/`Ctrl+R` or the background cadence timer runs one scan pass that streams per-file deltas into the ledger and broadcasts a single `store:changed` event — the renderer's only refetch trigger. There is no renderer polling loop, scans coalesce (a background scan and a manual scan never overlap), and a failing background scan leaves your last-known data visible (stale-while-revalidate). Every scan is abortable and reports progress per provider.

---

## Tech stack

| Layer | Tech |
|-------|------|
| **Main process** | Electron 43 · Node 22+ (`node:sqlite` for the ledger) · TypeScript 5.8 |
| **Renderer** | React 19 · Tailwind CSS 4 · shadcn/ui · Zustand · Recharts · GSAP · TanStack Hotkeys |
| **Data & contracts** | SQLite (built-in `node:sqlite`) · Zod 4 schemas shared between main and renderer |
| **Build & packaging** | electron-vite 5 · Vite 7 · electron-builder (Windows NSIS · macOS DMG/zip universal · Linux AppImage/deb, built in CI) |
| **Tests** | Vitest (`tests/`) |

---

## Quick start (development)

**Prerequisites:** Node.js **22+** (the ledger uses the built-in `node:sqlite` module) and npm.

```bash
npm install
npm run dev        # launches the Electron app with hot reload
```

On first launch the app scans your machine, finds every supported tool with session data on disk, and ports its history into the ledger. From then on the background cadence keeps it fresh.

> **macOS note:** reading tool data requires granting Watchtower **Full Disk Access** in System Settings (Privacy & Security). If a scan finds nothing on macOS, Settings shows a one-time banner that opens the right pane. Windows and Linux need no such grant (ADR 0015).

### Scripts

| Command | What it does |
|---------|--------------|
| `npm run dev` | Run the app in development (electron-vite) |
| `npm run build` | Compile main, preload, and renderer bundles |
| `npm run preview` | Preview a built app |
| `npm run typecheck` | Type-check both node and web targets (`typecheck:node` / `typecheck:web`) |
| `npm test` | Run the vitest suite (`tests/`) |
| `npm run package` | Build + package for the platform you're on (NSIS on Windows, DMG/zip on macOS, AppImage/deb on Linux) |
| `npm run package:win` / `package:mac` / `package:linux` | Build + package a specific platform (macOS must be built on macOS) |
| `npm run icons` | Regenerate `build/icon.png` from `assets/watchtower-logo.svg` |

---

## Supported tools

Watchtower auto-detects which AI tools you use by probing their on-disk data locations. Core providers load eagerly; heavy or platform-specific ones (Antigravity, Forge, Goose, Cursor, OpenCode, Cursor Agent, Crush, Warp, Vercel AI Gateway, ZCode, Zed) load lazily and never block a scan when their module can't load.

- Claude Code (including `CLAUDE_CONFIG_DIRS` aggregation), Claude Desktop sources
- Codex (OpenAI), GitHub Copilot (CLI, VS Code/VSCodium, JetBrains, OTel store), Cursor, Cursor Agent, OpenCode
- Gemini CLI, Antigravity, Grok, Qwen, Kimi, Kimi Code CLI, Kiro, Mistral Vibe, Hermes, LingTai TUI, Pi / OMP, OpenClaw, OpenDesign, QuickDesk, Mux, Zerostack
- Cline / Roo Code / KiloCode (VS Code family), CodeWhale, Codebuff, Devin, Droid, IBM Bob, Forge, Goose, Warp, Zed, Crush, ZCode, Vercel AI Gateway

That's **38 providers** in total. Each lives in a single file under `src/main/pipeline/providers/` and follows a common `Provider` contract — discovery, a session parser, and per-provider quirks. A provider that throws during discovery is skipped with a one-line warning; it can never take down the rest of the scan.

---

## Pricing & currency

- **Pricing** is fetched from [LiteLLM](https://github.com/BerriAI/litellm) (daily, cached locally), with a bundled snapshot and hardcoded fallbacks so a missing model degrades to a `$0.00` row you can price inline rather than a wrong number.
- **Currency** — any of 162 ISO 4217 codes. Exchange rates come from [Frankfurter](https://www.frankfurter.app/) (European Central Bank data, free, no API key), cached for 24 hours, and refreshed in the background on the scan cadence. The renderer never calls Frankfurter directly — the main process is its only read path, and money repaints the moment a fresh rate lands.
- **Local models** mapped to a paid baseline are counted as savings; paths routed through a subscription-backed proxy are reported separately as proxied cost.

---

## Releases & platforms

Installers for **Windows (NSIS), macOS (DMG/zip, one universal binary for Apple Silicon and Intel), and Linux (AppImage/deb)** are built in CI — typecheck + tests on every PR, installers as artifacts on `main`, and a GitHub Release with all three attached when a `v*` tag is pushed (ADR 0015).

Artifacts are currently **unsigned** by design: Windows shows a SmartScreen "unknown publisher" warning and macOS users must right-click → Open the first time. Code signing is sign-ready — drop `CSC_LINK`/`CSC_KEY_PASSWORD` into CI secrets and builds sign themselves. macOS notarization needs a one-line config flip (`mac.notarize: true`) plus Apple secrets first (ADR 0015).

---

## Data & privacy

- Watchtower **reads only local files** that your tools already wrote — it never intercepts, proxies, or modifies them (the Optimize section is read-only).
- The ledger lives in Electron's `userData` directory (`ledger.db`), with the session cache next to it in `cache/`.
- **Nothing leaves your machine** except, when enabled: the daily LiteLLM pricing fetch and the Frankfurter FX fetch. There is no telemetry, no analytics, no account, and no update auto-installer.
- A background scan that fails does so silently — your last-known data stays on screen.

### Environment variables

| Variable | Description |
|----------|-------------|
| `WATCHTOWER_CACHE_DIR` | Override the session-cache directory (set automatically to `<userData>/cache` at startup) |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | (Optional) code-signing certificate for Windows/macOS builds — signs when present, skips when absent |

Per-provider data locations honor each tool's own overrides where supported (e.g. `CLAUDE_CONFIG_DIR`, `CLAUDE_CONFIG_DIRS`, `CODEX_HOME`).

---

## Project layout

```
src/
├─ main/                    # Electron main process — owns everything
│  ├─ index.ts              # window, IPC surface, scan orchestration, cadence
│  ├─ cadence.ts            # background scan / FX refresh cadence
│  ├─ views.ts              # dashboard, session, project, and search payloads
│  ├─ overview.ts           # Overview payload (KPIs, efficiency, workflow)
│  ├─ sessions-view.ts      # Sessions payload
│  ├─ pull-requests-view.ts # PR spend payload
│  ├─ spend-view.ts         # daily spend + Sankey payload
│  ├─ models-view.ts        # by-model / by-task / audit payloads
│  ├─ compare-view.ts       # model-pair comparison payload
│  ├─ optimize-view.ts      # the 16 waste detectors + setup-health grade
│  ├─ yield-view.ts         # productive / reverted / abandoned git attribution
│  ├─ fx.ts                 # Frankfurter exchange-rate cache
│  ├─ export.ts             # CSV/JSON export
│  ├─ updates.ts            # manual update check (GitHub releases)
│  ├─ pipeline/             # discovery → extraction → parse → classify → price
│  │  ├─ scan.ts            # runScan: one scan pass, metadata out
│  │  ├─ parser.ts          # the parse pipeline and delta seam
│  │  ├─ session-cache.ts   # on-disk cache with per-file fingerprints
│  │  ├─ models.ts          # LiteLLM pricing + fallbacks + aliases
│  │  └─ providers/         # one file per tool (38 providers)
│  └─ store/
│     ├─ ledger.ts          # accumulating SQLite ledger (source/call/turn/session)
│     ├─ port.ts            # cache-file → ledger-row mapping
│     └─ aggregate.ts       # query-time aggregation helpers
├─ preload/                 # typed contextBridge API (the renderer's only door)
├─ shared/schemas/          # zod schemas — single source of truth
└─ renderer/                # React 19 + Tailwind + shadcn/ui (sandboxed)
   ├─ app/                  # AppShell, sidebar/topbar, onboarding, stores, shortcuts
   ├─ features/             # one folder per section (overview, sessions, spend, …)
   └─ shared/               # UI kit, libs, and hooks
```

Key architectural decisions are recorded as ADRs referenced inline in the code — e.g. the shortcut registry (ADR 0001) in `src/renderer/src/app/shortcuts.ts`.

---

## License

MIT — see [LICENSE](./LICENSE). Pricing data from [LiteLLM](https://github.com/BerriAI/litellm); exchange rates from [Frankfurter](https://www.frankfurter.app/).
