# Developing Watchtower

## Prerequisites

Node.js **22+** (the ledger uses the built-in `node:sqlite` module) and npm.

## Getting started

Install dependencies and launch the app in development:

```bash
npm install
npm run dev        # launches the Electron app with hot reload
```

The README's [Quick start](../README.md#quick-start) covers first-launch
behavior and the macOS Full Disk Access requirement.

## Effect conventions

The backend uses Effect 4 for application workflows, service composition,
typed operational failures, and scoped resources. `effect` and
`@effect/sql-sqlite-node` are pinned to `4.0.0-rc.115`. Before writing Effect
code, read the installed `node_modules/effect/AGENTS.md` completely and follow
its required links, as specified in [the agent guide](./agents/effect.md).
Use the installed source for APIs on this release line.

- Compose capabilities with `Context.Service` and `Layer`. Main, db-worker,
  and MCP query processes own separate runtimes and resource lifetimes.
  Keep runtime construction and `run*` calls at composition roots and external
  adapters.
- Put query and command orchestration in `src/main/application/`. Reuse the
  repository capabilities over the isolate's SQL client. Each SQLite operation
  completes synchronously, with no Promise yield inside its transaction.
- Define contracts with Effect Schema and derive their TypeScript types.
  Distinguish stored/encoded representations from decoded values and IPC
  payloads. Preserve unknown-key stripping and extraction skip-and-tally
  behavior. Watchtower has no owned Zod contracts or direct Zod dependency;
  SDK-internal protocol schemas remain the dependency's responsibility.
- Keep calculations and transformations as plain functions. The renderer
  keeps React, Zustand, and the Promise IPC facade; its synchronous Schema
  decoder needs no application runtime, Layer, fiber, or backend IO.
- Test services with substitute Layers and fakes. Use `TestClock` for
  time-dependent behavior and real SQLite integration tests for transaction
  and migration behavior. Check expected failure, interruption, and cleanup
  where the workflow owns resources.

See [the architecture](./architecture.md#the-effect-first-backend),
[ADR 0032](./adr/0032-effect-first-backend-architecture.md), and
[ADR 0034](./adr/0034-effect-schema-contract-authority.md) for the current
boundaries. Earlier ADR adoption limits are historical where these decisions
supersede them.

## Scripts

| Command                                                 | What it does                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `npm run dev`                                           | Run the app in development (electron-vite)                                                             |
| `npm run build`                                         | Compile main, preload, and renderer bundles                                                            |
| `npm run preview`                                       | Preview a built app                                                                                    |
| `npm run typecheck`                                     | Type-check both node and web targets (`typecheck:node` / `typecheck:web`)                              |
| `npm test`                                              | Run the vitest suite (`tests/`)                                                                        |
| `npm run test:e2e`                                      | Build the bundles, then run the Playwright Electron smoke (`e2e/`)                                     |
| `npm run lint`                                          | ESLint v9 flat gate (`eslint.config.mjs`) — blocking in CI (`test.yml`)                                |
| `npm run lint:fix`                                      | Autofix what ESLint can (import order), report the rest                                                |
| `npm run format`                                        | Rewrite everything with Prettier (`.prettierrc.json`)                                                  |
| `npm run format:check`                                  | Check formatting with Prettier; blocking in CI                                                         |
| `npm run package`                                       | Build + package for the platform you are on (NSIS on Windows, DMG/zip on macOS, AppImage/deb on Linux) |
| `npm run package:win` / `package:mac` / `package:linux` | Build + package a specific platform (macOS must be built on macOS)                                     |
| `npm run icons`                                         | Regenerate `build/icon.png` from `assets/watchtower-logo.svg`                                          |

## End-to-end tests

Unit/integration coverage lives in `tests/` (Vitest). The Electron smoke lives
in `e2e/` (Playwright, `playwright.config.ts`) and drives the real app window:

```bash
npm run test:e2e
```

What it does: builds the current bundles (`out/`, git-ignored), launches
`electron .` with a fresh `--user-data-dir` under the OS temp root, and
asserts boot (window title), first-run onboarding dismissal, and
Overview ↔ Sessions navigation with no renderer `pageerror`. The temp profile
is deleted afterwards. Note the isolation boundary: the ledger destination is
isolated, but the boot scan still READS the host's real assistant sources
(read-only) — your files are never modified, but the run sees your data.

First launch hydrates through a full scan of the host's real assistant sources
(read-only — only the ledger destination is isolated), so the first run can
take minutes; the ceiling in `playwright.config.ts` reflects that.

Notes:

- No browser download needed: Electron specs drive the repo's own Electron
  binary, so `npx playwright install` is NOT required.
- `npx playwright test` alone reuses the last `npm run build` output when you
  want to iterate without rebuilding.
- Linux without a display needs a virtual server (`xvfb-run -a npm run
test:e2e`); Windows and macOS run headed as-is. There is no headless mode:
  Electron always opens a real window (Linux fakes the display via xvfb).
- CI runs the suite non-blocking via `.github/workflows/e2e.yml`
  (Windows + Linux matrix, `xvfb-run` on Linux) — failures notify but never
  block the `test.yml` merge gate; promoting it into the gate is tracked in
  #135.

### Adding a spec

`e2e/app.ts` owns the launch fixture — reuse it, don't relaunch by hand:

| File                          | Covers                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/app.ts`                  | `launchApp` (isolated `--user-data-dir`, `pageErrors` tap), `dismissOnboarding`, `waitForAnyVisible`, `withApp` (lifecycle + zero-`pageerror` assert) |
| `e2e/smoke.spec.ts`           | Boot, onboarding dismissal, Overview ↔ Sessions                                                                                                       |
| `e2e/sections.spec.ts`        | Every sidebar destination renders (extend the `MARKERS` map for new sections)                                                                         |
| `e2e/command-palette.spec.ts` | Mod+K → filter → Enter navigates                                                                                                                      |

Rules (the boot scan reads the host's real sources read-only, so content
varies machine to machine): never assert data values, row counts, or URLs
(memory-history router); key readiness off `dismissOnboarding` (a hidden
splash also matches pre-mount); assert views with content-OR-empty markers
via `waitForAnyVisible`; wrap every spec in `withApp` (asserts zero
`pageerror`s for you).

## Lint & formatting

ESLint v9 (flat `eslint.config.mjs`) + Prettier (`.prettierrc.json`), scaffolded
in #136 out of #123 (W6/W11/W14 + Phase 1 lint gate):

- **Process boundaries are the point.** The renderer is sandboxed (ADR 0005) and
  the data plane lives on the db-worker (ADR 0023) — `npm run lint` fails on any
  `electron`/`node:*` import inside `src/renderer/`, any `main ↔ renderer`
  cross-import, or any `window`/`document` use inside `src/main/`. Preload keeps
  its `import type` contract from `../main/**` (IPC wire types); value imports
  from main would break the sandbox and there are none.
- **Warn-first, by design.** The tree predates the gate, so pervasive
  pre-existing style (non-null assertions, import order, unused vars, control-
  char sanitizer regexes, dynamic cache deletes) reports as warnings while the
  gate stays green — each gets promoted to error with its own cleanup diff in
  the follow-up, never as one giant reformatting PR.
- **Formatting blocks CI.** `npm run format:check` runs in `test.yml` alongside
  lint. `.prettierignore` preserves hand-authored layouts such as the README
  and excludes generated outputs and vendored skills. `endOfLine` is `auto`;
  preserve each file's existing line endings.
- Editor: install the ESLint + Prettier extensions — `.vscode/settings.json`
  already turns on format-on-save and fix-on-save.

## Project layout

```
e2e/                      # Playwright Electron specs (npm run test:e2e)
├─ app.ts                 # launch fixture: launchApp, dismissOnboarding, waitForAnyVisible, withApp
├─ smoke.spec.ts          # boot + onboarding + Overview ↔ Sessions
├─ sections.spec.ts       # all-section render walk (MARKERS map)
└─ command-palette.spec.ts # Mod+K → filter → Enter navigates
playwright.config.ts      # testDir e2e, single worker, generous first-scan ceiling
src/
├─ main/                    # backend code, run in main, worker, or MCP processes
│  ├─ index.ts              # Electron startup, windows, IPC, worker coordination
│  ├─ main-runtime.ts       # main-process Effect service graph
│  ├─ worker-runtime.ts     # worker Effect graph, SQL client, ledger initialization
│  ├─ background-shell.ts   # scoped tray, orb windows, subscriptions, delayed work
│  ├─ env.ts                # Effect Config, Env service, captured AppPaths
│  ├─ operational-log.ts    # shared Logger/Metric/Tracer integration
│  ├─ db-worker/
│  │  ├─ entry.ts           # worker startup, scan fibers, cadence, shutdown
│  │  ├─ client.ts          # main-to-worker Promise and event adapter
│  │  ├─ query-dispatch.ts  # query routes into application workflows
│  │  ├─ config-dispatch.ts # settings command routes
│  │  └─ protocol.ts        # typed worker request/response/event contract
│  ├─ application/          # Effect queries, commands, capability definitions
│  ├─ *-calculation.ts      # pure section, export, and pricing calculations
│  ├─ cadence.ts            # background scan / FX cadence policy
│  ├─ fx.ts                 # Effect FX service and Frankfurter cache
│  ├─ updates.ts            # manual update check (GitHub releases)
│  ├─ agents/               # the Coach & Skills harness surface (ADRs 0016–0021)
│  │  ├─ detect.ts          # harness discovery over the spec registry
│  │  ├─ runtime.ts         # the HarnessRuntime seam (AI SDK + ACP provider)
│  │  ├─ harnesses/         # one spec file per drivable CLI (claude, codex, …)
│  │  ├─ ledger-mcp/        # official SDK server, Schema tool inputs, read-only runtime
│  │  ├─ prompts.ts         # the one briefing: coaching + skill authoring scopes
│  │  ├─ events.ts          # ACP stream → CoachEvent derivation
│  │  └─ ipc.ts             # coach:harnesses/run/inspect/cancel/reset wire
│  ├─ pipeline/             # discovery -> extraction -> parse -> classify -> price
│  │  ├─ scan.ts            # Effect scan orchestration, metadata out
│  │  ├─ parser.ts          # native parser streams and per-file delta seam
│  │  ├─ session-cache.ts   # Effect cache IO with per-file fingerprints
│  │  ├─ models.ts          # LiteLLM pricing + fallbacks + aliases
│  │  └─ providers/         # one file per tool (38 providers)
│  └─ store/
│     ├─ ledger-repository.ts # Effect repository services over one SQL client
│     ├─ ledger-ports.ts     # focused ingest, query, and settings capabilities
│     ├─ ledger-*-reads.ts   # focused view, session, and export reads
│     ├─ *-read-projections.ts # SQL row projections and decoders
│     ├─ sqlite-migrations.ts # versioned ledger DDL through Effect SQL
│     ├─ port.ts            # cache-file -> ledger-row mapping
│     └─ aggregate-calculation.ts # pure query-time aggregation helpers
├─ preload/                 # typed contextBridge API (the renderer's only door)
├─ shared/schemas/          # Effect Schema contracts and derived types; UI-only types
└─ renderer/src/            # React 19 + Tailwind + shadcn/ui (sandboxed)
   ├─ app/                  # AppShell, sidebar/topbar, onboarding, stores, shortcuts
   ├─ features/             # one folder per section (overview, sessions, spend, coach-skills, ...)
   └─ shared/               # UI kit, hooks, Promise IPC API, synchronous Schema decoder
```

Architecture decisions are recorded as ADRs in [`docs/adr`](./adr) and
referenced inline in the code, for example the shortcut registry (ADR 0001) in
`src/renderer/src/app/shortcuts.ts`. A glossary of domain terms lives in
[`CONTEXT.md`](../CONTEXT.md).

## Environment variables

| Variable                        | Description                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `WATCHTOWER_CACHE_DIR`          | Override the session-cache directory (set automatically to `<userData>/cache` at startup)           |
| `CSC_LINK` / `CSC_KEY_PASSWORD` | (Optional) code-signing certificate for Windows/macOS builds; signs when present, skips when absent |
