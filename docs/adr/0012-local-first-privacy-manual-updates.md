# Local-first privacy: no telemetry, and updates are manual and informational only

Status: accepted

Watchtower reads only local files that the user's tools already wrote; the ledger lives in Electron's `userData` directory. **Nothing leaves the machine except, when enabled, the daily LiteLLM pricing fetch and the Frankfurter FX fetch.** There is no telemetry, no analytics, no account — and because there is no telemetry, the first-launch onboarding has no consent step (there is nothing to consent to).

**Updates are manual-only and informational-only.** `src/main/updates.ts` is never touched except when the user clicks "Check for updates" in Settings › About: there is no background timer, no launch-time check, and no auto-download/install. The check is a plain, unauthenticated GitHub Releases read that sends no identifiers and no auth token; offline, an unpublished/private repo, or any other error is a silent no-op that reports "unable to check" and never blocks anything. A release tag convention (`desktop-v` prefix optional) is tolerated so it can be chosen later without a code change.

**Why:** a telemetry dashboard for coding tools is a surveillance-prone category; "the app is the reader, your tools are the source of truth" only holds if the reader is trustworthy by construction. Manual-only updates keep the app's only network reachable from an explicit user click, and its only network traffic (pricing, FX) is data the user can switch off.
