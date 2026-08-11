# Local-first privacy: no telemetry, and updates are manual and informational only

Status: accepted

Watchtower reads only local files that the user's tools already wrote; the ledger lives in Electron's `userData` directory. **Nothing leaves the machine except, when enabled, the daily LiteLLM pricing fetch and the Frankfurter FX fetch.** There is no telemetry, no analytics, no account — and because there is no telemetry, the first-launch onboarding has no consent step (there is nothing to consent to).

**Updates are manual-only and informational-only.** `src/main/updates.ts` is never touched except when the user clicks "Check for updates" in Settings › About: there is no background timer, no launch-time check, and no auto-download/install. The check is a plain, unauthenticated GitHub Releases read that sends no identifiers and no auth token; offline, an unpublished/private repo, or any other error is a silent no-op that reports "unable to check" and never blocks anything. A release tag convention (`desktop-v` prefix optional) is tolerated so it can be chosen later without a code change.

**Why:** a telemetry dashboard for coding tools is a surveillance-prone category; "the app is the reader, your tools are the source of truth" only holds if the reader is trustworthy by construction. Manual-only updates keep the app's only network reachable from an explicit user click, and its only network traffic (pricing, FX) is data the user can switch off.

---

## Addendum (2026-08-11): Consented exception — Coach and Skills agents

Coach and Skills (the agent Sections, tickets 19–26) need ONE network path that the section above otherwise forbids: sending **ledger-derived context** to the user's own coding-agent CLI (Claude Code, Codex, Gemini, …) so it can answer. That CLI, driven locally via the Agent Client Protocol (`createACPProvider` on the AI SDK v6), forwards the prompt to its own model provider. This addendum records the single, user-consented exception to the local-first guarantee.

Conditions (all enforced in code):

1. **One-time opt-in, default off.** No agent call is ever made until the user grants consent (a first-run dialog, "Enable agents" / "Not now"). Consent is persisted by the **main process** (a ledger config table, `agents_consent_config`) and is revocable in Settings › Privacy & data. The main process's runner **refuses every unconsented run**, so a stale or bypassed renderer can never leak data past the gate.
2. **Aggregated / normalized context only — never raw transcripts.** The Coach sends aggregated figures through the ledger's aggregation seam; Skills sends normalized patterns (commands stripped of arguments and paths). Raw session transcripts never leave the machine.
3. **No API keys.** Auth is always the host CLI's own stored login; the harness spawn scrubs provider API keys from the child env (`scrubEnv`). The app never asks for or stores keys.
4. **All other network traffic unchanged.** Pricing (LiteLLM) and FX (Frankfurter) fetches keep their existing behavior; nothing else becomes reachable.

While the opt-in is off, both agents keep working in offline/template mode (no harness call), so declining never degrades the rest of the app.
