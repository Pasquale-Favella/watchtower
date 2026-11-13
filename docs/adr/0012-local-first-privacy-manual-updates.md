# Local-first privacy and user-initiated updates

Status: accepted

Watchtower reads only local files that the user's tools already wrote; the ledger lives in Electron's `userData` directory. **Nothing leaves the machine except, when enabled, the daily LiteLLM pricing fetch and the Frankfurter FX fetch.** There is no telemetry, no analytics, no account — and because there is no telemetry, the first-launch onboarding has no consent step (there is nothing to consent to).

**Updates require explicit user actions.** Issue #161 revises the original informational-only decision. Settings > About uses electron-updater to check GitHub Releases, download a compatible stable update, show progress, and restart to install. Checking does not download; downloading does not authorize installation. There is no launch-time check, background polling, forced restart, prerelease selection, or downgrade. A normal quit does not install a downloaded update. The shared main-process runtime owns update work and progress subscriptions; shutdown cancels downloads and closes app resources before the updater can start installation.

The public GitHub provider has no credentials. Its staging identifier header is overwritten with an empty value and its raw library logger is disabled. Only fixed operation/error codes reach the local operational log. GitHub and its artifact hosts necessarily receive ordinary network connection metadata during an explicit request. No ledger facts, local paths, prompts, or account identifiers are included.

Windows NSIS installations and Linux AppImage releases support in-app updates. macOS requires a release built with Developer ID signing and notarization. Ad-hoc macOS builds, Linux deb installations, development builds, and unpacked Windows directories expose the release-page fallback. Existing versions need one manual upgrade to receive the updater; moving an ad-hoc macOS installation to the first Developer ID release also requires a manual replacement.

**Why:** explicit check, download, and installation controls preserve the original user-initiated network policy while removing repeated manual artifact installation on supported targets. The informational-only restriction no longer applies. Background checks and staged rollouts remain outside this decision.

---

## Addendum (2026-08-11): Harness runs — user-initiated, on the machine's own CLIs

Coach & Skills (the agent Sections, tickets 19–26, unified in ADR 0017) drive the user's OWN installed coding-agent CLIs (Claude Code, Codex, Gemini, …) via the Agent Client Protocol (`createACPProvider` on the AI SDK v6). Each run is **user-initiated from an explicit click** in the unified Coach & Skills chat; the harness runs in a user-picked workspace (the OS directory picker IS the authorization).

Conditions (all enforced in code):

1. **Aggregated / normalized context only — never raw transcripts.** Coach runs send only what the user typed; the harness never receives raw session transcripts. (The former build-skill evidence flow — normalized detection patterns over `coach:run` — was deleted in ADR 0021: the agent grounds itself through the read-only ledger MCP tools instead.)
2. **No API keys.** Auth is always the host CLI's own stored login; the harness spawn scrubs provider API keys from the child env (`scrubEnv`). The app never asks for or stores keys.
3. **The prompt leaves the machine only through the user's own harness CLI.** The app adds no network path of its own for agents; everything else keeps its existing behavior (pricing, FX, manual updates).

---

## Addendum (2026-11-02): Project setup — user-initiated, through the user's own `git` and `gh`

The workspace Add project palette can create a folder, initialize it, clone a repository, and publish a new project as a private GitHub repository. Each action follows an explicit Enter or click in that palette; nothing runs on open except a local `gh auth status` readiness check, which reads gh's stored login and sends nothing of the app's.

Conditions (all enforced in code, `src/infrastructure/filesystem/project-provisioner.ts`):

1. **No app-owned network path or credentials.** Cloning uses the user's `git` (Git URLs) or `gh repo clone` (GitHub); lookup and publishing use `gh repo view` and `gh repo create --private`. Authentication is always the tool's own stored login. The app never asks for, reads, or stores tokens, and runs both tools with prompts disabled.
2. **Only what the user typed leaves the machine.** A clone sends the remote address the user entered; a lookup sends `owner/name`; publishing sends the folder-derived repository name and pushes nothing. Ledger facts, prompts and other paths are never included.
3. **No tool output crosses the RPC boundary.** Git and gh output can contain credentials or local paths, so failures surface as fixed messages per code (`ProjectSetupError`) and are not logged raw.
4. **Nothing is overwritten.** A clone destination must be missing or empty; a repeated command recognizes only its own finished clone (matching `origin`), and publishing leaves an existing `origin` untouched. `git init` never runs inside an existing repository.

**Why:** these are the same user-initiated, own-CLI terms as the harness addendum above, applied to project setup. The alternative, an app-owned GitHub API client, would require Watchtower to hold credentials and add a network path of its own.
