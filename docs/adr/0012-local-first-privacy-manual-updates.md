# Local-first privacy: no telemetry, and updates are manual and informational only

Status: accepted

Watchtower reads only local files that the user's tools already wrote; the ledger lives in Electron's `userData` directory. **Nothing leaves the machine except, when enabled, the daily LiteLLM pricing fetch and the Frankfurter FX fetch.** There is no telemetry, no analytics, no account — and because there is no telemetry, the first-launch onboarding has no consent step (there is nothing to consent to).

**Updates are manual-only and informational-only.** `src/main/updates.ts` is never touched except when the user clicks "Check for updates" in Settings › About: there is no background timer, no launch-time check, and no auto-download/install. The check is a plain, unauthenticated GitHub Releases read that sends no identifiers and no auth token; offline, an unpublished/private repo, or any other error is a silent no-op that reports "unable to check" and never blocks anything. A release tag convention (`desktop-v` prefix optional) is tolerated so it can be chosen later without a code change.

**Why:** a telemetry dashboard for coding tools is a surveillance-prone category; "the app is the reader, your tools are the source of truth" only holds if the reader is trustworthy by construction. Manual-only updates keep the app's only network reachable from an explicit user click, and its only network traffic (pricing, FX) is data the user can switch off.

---

## Addendum (2026-08-11): Harness runs — user-initiated, on the machine's own CLIs

Coach & Skills (the agent Sections, tickets 19–26, unified in ADR 0017) drive the user's OWN installed coding-agent CLIs (Claude Code, Codex, Gemini, …) via the Agent Client Protocol (`createACPProvider` on the AI SDK v6). Each run is **user-initiated from an explicit click** in the unified Coach & Skills chat; the harness runs in a user-picked workspace (the OS directory picker IS the authorization).

Conditions (all enforced in code):

1. **Aggregated / normalized context only — never raw transcripts.** Coach runs send only what the user typed; the harness never receives raw session transcripts. (The former build-skill evidence flow — normalized detection patterns over `coach:run` — was deleted in ADR 0021: the agent grounds itself through the read-only ledger MCP tools instead.)
2. **No API keys.** Auth is always the host CLI's own stored login; the harness spawn scrubs provider API keys from the child env (`scrubEnv`). The app never asks for or stores keys.
3. **The prompt leaves the machine only through the user's own harness CLI.** The app adds no network path of its own for agents; everything else keeps its existing behavior (pricing, FX, manual updates).
