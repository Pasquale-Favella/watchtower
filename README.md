<div align="center">

<img src="assets/watchtower-logo.svg" alt="Watchtower" width="96" />

# Watchtower

**Every agent. One dashboard.**

A local-first desktop dashboard that turns the session files your AI coding tools already write to disk into a clear picture of your token usage and spend, broken down by tool, model, project, and task.

[![Version](https://img.shields.io/badge/version-0.2.1-1e3a8a?style=flat-square)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Windows | macOS | Linux](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square)](electron-builder.yml)
[![Local-first](https://img.shields.io/badge/privacy-local--first-success?style=flat-square)](#data--privacy)

</div>

Claude Code, Codex, Cursor, Copilot, Gemini, and 30+ more tools are read straight from this machine. Nothing is uploaded, nothing is proxied, and no API keys are needed: the app is the reader, your tools are the source of truth.

[Highlights](#highlights) · [Installation](#installation) · [The app](#the-app) · [Tech stack](#tech-stack) · [Quick start](#quick-start) · [Supported tools](#supported-tools) · [Documentation](#documentation) · [Data & privacy](#data--privacy)

## Highlights

- **38 providers, no API keys.** Tools are detected from the session stores they already write to disk (SQLite, JSONL, JSON).
- **Incremental scans.** A background cadence ports only what changed since the last pass, so a full history builds once and stays fresh cheaply.
- **An accumulating ledger.** Raw transcript facts land in a local SQLite store; every view is derived at query time, so changing a price or an alias repaints the dashboard instantly.
- **A local coach.** Chat with your own coding-agent harness (Claude Code, Codex, OpenCode, …) about your usage. It reads the same local ledger the dashboard shows, so every answer — and every SKILL.md it crafts — is grounded in your real history, not guesses.
- **Sandboxed renderer.** All data stays in the main process. The UI receives schema-validated payloads over IPC and validates them again on arrival.
- **No telemetry.** The only network traffic is the optional pricing (LiteLLM) and exchange-rate (Frankfurter) refreshes.

## Installation

Download the installer for your platform from the [latest release](https://github.com/Pasquale-Favella/watchtower/releases/latest). The links below always resolve to the newest build.

| Platform | Installer | Install |
|---|---|---|
| **Windows** (x64) | [`Watchtower-win-x64.exe`](https://github.com/Pasquale-Favella/watchtower/releases/latest/download/Watchtower-win-x64.exe) | Run the installer (NSIS). |
| **macOS** (Apple Silicon + Intel) | [`Watchtower-mac-universal.dmg`](https://github.com/Pasquale-Favella/watchtower/releases/latest/download/Watchtower-mac-universal.dmg) | Open the DMG, drag Watchtower into Applications. |
| **Linux** (x64) | [`Watchtower-linux-x64.AppImage`](https://github.com/Pasquale-Favella/watchtower/releases/latest/download/Watchtower-linux-x64.AppImage) | `chmod +x Watchtower-linux-x64.AppImage && ./Watchtower-linux-x64.AppImage` |
| **Linux** (Debian/Ubuntu) | [`Watchtower-linux-x64.deb`](https://github.com/Pasquale-Favella/watchtower/releases/latest/download/Watchtower-linux-x64.deb) | `sudo apt install ./Watchtower-linux-x64.deb` |

Every release ships all three platforms. AppImage and `.deb` are the two Linux flavors; macOS ships one universal binary that runs on both Apple Silicon and Intel.

> [!WARNING]
> Installers are currently **unsigned**. Windows may show a SmartScreen "unknown publisher" warning, and on macOS you will need to right-click and choose **Open** the first time. See [Releases](#releases).

## The app

| Section | Shortcut* | What it shows |
|---------|-----------|---------------|
| **Overview** | `1` | KPIs (cost, calls, sessions, tokens, cache hit, savings), a daily spend chart, top models/activities/tools, an A+ to F efficiency grade, workflow signals, and local-model savings |
| **Sessions** | `2` | Every working session, searchable and filterable; click any row to drill into a turn-by-turn timeline with per-call usage |
| **Pull Requests** | `3` | Spend attributed to each PR from real git history, so the cost of shipped work is trustworthy |
| **Spend** | `4` | Daily spend stacked by model and by project, plus a Sankey flow showing where money moves from models to projects |
| **Optimize** | `5` | Sixteen waste detectors with copy-paste fixes, an A+ to F setup-health grade, and a Yield tab for productive vs. reverted/abandoned spend |
| **Models** | `6` | Per-model cost, tokens, and calls, broken down by task and audited down to the token, with inline quick-add pricing for unpriced models |
| **Compare** | `7` | Pick two models and see one-shot rate, retry rate, cost per call, and cache-hit rate side by side |
| **Coach & Skills** | `8` | A chat with your own coding-agent CLI about your usage — ask anything and the harness answers from the same ledger the dashboard shows, or craft a SKILL.md together by talking (suggested-skill chips start the conversation) |
| **Settings** | `,` | Theme, refresh cadence, default period, provider info, model aliases, pricing overrides, export, and privacy controls |

*\* Every section also shares a period switcher (Today, 7D, 30D, Month, 6M, Life, or a custom date range) and a provider filter. The Coach reads the current window as the suggested default for its answers. The full shortcut list and per-section details are in the [usage guide](docs/usage.md).*

## Tech stack

| Layer | Tech |
|-------|------|
| **Main process** | Electron 43, Node 22+ (`node:sqlite` for the ledger), TypeScript 5.8 |
| **Renderer** | React 19, Tailwind CSS 4, shadcn/ui, Zustand, Recharts, GSAP, TanStack Hotkeys |
| **Data & contracts** | SQLite (built-in `node:sqlite`), Zod 4 schemas shared between main and renderer |
| **Build & packaging** | electron-vite 5, Vite 7, electron-builder (Windows NSIS, macOS DMG/zip universal, Linux AppImage/deb, built in CI) |
| **Tests** | Vitest (`tests/`) |

## Quick start

**Prerequisites:** Node.js **22+** (the ledger uses the built-in `node:sqlite` module) and npm.

```bash
npm install
npm run dev        # launches the Electron app with hot reload
```

On first launch the app scans your machine, finds every supported tool with session data on disk, and ports its history into the ledger. From then on the background cadence keeps it fresh.

> [!IMPORTANT]
> **macOS only:** reading tool data requires granting Watchtower **Full Disk Access** in System Settings (Privacy & Security). If a scan finds nothing on macOS, Settings shows a one-time banner that opens the right pane. Windows and Linux need no such grant (ADR 0015).

Scripts, the project layout, and environment variables live in the [development guide](docs/development.md).

## Supported tools

Watchtower auto-detects which AI tools you use by probing their on-disk data locations. Core providers load eagerly; heavy or platform-specific ones (Antigravity, Forge, Goose, Cursor, OpenCode, Cursor Agent, Crush, Warp, Vercel AI Gateway, ZCode, Zed) load lazily and never block a scan when their module cannot load.

- Claude Code (including `CLAUDE_CONFIG_DIRS` aggregation) and Claude Desktop sources
- Codex (OpenAI), GitHub Copilot (CLI, VS Code/VSCodium, JetBrains, OTel store), Cursor, Cursor Agent, OpenCode
- Gemini CLI, Antigravity, Grok, Qwen, Kimi, Kimi Code CLI, Kiro, Mistral Vibe, Hermes, LingTai TUI, Pi / OMP, OpenClaw, OpenDesign, QuickDesk, Mux, Zerostack
- Cline / Roo Code / KiloCode (VS Code family), CodeWhale, Codebuff, Devin, Droid, IBM Bob, Forge, Goose, Warp, Zed, Crush, ZCode, Vercel AI Gateway

That is **38 providers** in total. Each lives in a single file under `src/main/pipeline/providers/` and follows a common `Provider` contract: discovery, a session parser, and per-provider quirks. A provider that throws during discovery is skipped with a one-line warning; it can never take down the rest of the scan.

## Pricing & currency

- **Pricing** is fetched from [LiteLLM](https://github.com/BerriAI/litellm) daily and cached locally, with a bundled snapshot and hardcoded fallbacks, so a missing model degrades to a `$0.00` row you can price inline rather than a wrong number.
- **Currency** covers 162 ISO 4217 codes. Exchange rates come from [Frankfurter](https://www.frankfurter.app/) (European Central Bank data, free, no API key), cached for 24 hours, and refreshed in the background on the scan cadence. The renderer never calls Frankfurter directly; the main process is its only read path, and money repaints the moment a fresh rate lands.
- **Local models** mapped to a paid baseline are counted as savings; paths routed through a subscription-backed proxy are reported separately as proxied cost.

## Releases

Installers for **Windows (NSIS), macOS (DMG/zip, one universal binary for Apple Silicon and Intel), and Linux (AppImage/deb)** are built in CI only when a `v*` tag is pushed (ADR 0015). Typecheck and tests run on every PR and every push to `main` as the merge-readiness gate; a tag then builds all three installers and publishes them as a GitHub Release.

Artifacts are currently **unsigned** by design: Windows shows a SmartScreen "unknown publisher" warning, and macOS users must right-click and choose Open the first time. Code signing is sign-ready; drop `CSC_LINK`/`CSC_KEY_PASSWORD` into CI secrets and builds sign themselves. macOS notarization needs a one-line config flip (`mac.notarize: true`) plus Apple secrets first (ADR 0015).

## Documentation

- [**Usage guide**](docs/usage.md): keyboard shortcuts, the period and provider scope, and what each of the nine sections shows in detail
- [**Development guide**](docs/development.md): prerequisites, npm scripts, project layout, environment variables
- [**Architecture**](docs/architecture.md): the data pipeline, ledger, extraction seam, scan loop, and ADRs

## Data & privacy

- Watchtower **reads only local files** that your tools already wrote. It never intercepts, proxies, or modifies them (the Optimize section is read-only).
- The ledger lives in Electron's `userData` directory (`ledger.db`), with the session cache next to it in `cache/`.
- **Nothing leaves your machine** except, when enabled, the daily LiteLLM pricing fetch and the Frankfurter FX fetch. There is no telemetry, no analytics, no account, and no update auto-installer.
- A background scan that fails does so silently; your last-known data stays on screen.
- Per-provider data locations honor each tool's own overrides where supported (for example `CLAUDE_CONFIG_DIR`, `CLAUDE_CONFIG_DIRS`, `CODEX_HOME`).
