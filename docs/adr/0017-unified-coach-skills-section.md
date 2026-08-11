# Unified Coach & Skills section: one mode-tagged harness chat, no consent gate

Status: accepted

## Context

The Coach and Skills chains landed as two separate sections on the same HarnessRuntime seam (ADR 0016): a Coach run surface (ticket 23, never shipped in the renderer — only the store existed) and a Skills detection board with a separate one-shot draft-prose runner (tickets 24–25). Two things did not survive contact with the real product:

1. **Two sections, two mental models.** The user asked for ONE surface: *"a common section where we can tag one of the two agents — Coach or Skills — for coaching or building skill."* The machine's harnesses are the shared engine for both; splitting them into sibling sections duplicated pickers, state, and prose plumbing.
2. **The consent gate was the wrong privacy model here.** Ticket 22 (ADR 0012 addendum) gated every harness run behind a persisted opt-in toggle, on the theory that ledger-derived data reaches a harness's model provider. The user's direction revoked that: *"no permission — we are using the harnesses on the machine."* The harnesses are the user's own installed CLIs, the app drives them in the user's own workspace, and every run is user-initiated from an explicit click. A gate between the user and their own tooling added friction without adding safety the OS-user model doesn't already provide.

Additionally, model selection is not yet available through ACP (upstream PR #182), so a per-run *model* picker is aspirational; the per-harness picker remains.

## Decision

### 1. One "Coach & Skills" section, one chat surface

The `skills` and coach (unbuilt) sections merge into a single **Coach & Skills** section (`coachSkills`, route `/coach-skills`, `Mod+8`). The surface is a chat thread: user bubbles, streaming assistant turns with tool-call notices, and session resume on follow-up coach turns.

### 2. Mode-tagged runs on one channel

Every run goes through the existing `coach:run` wire, now mode-tagged (`CoachMode = 'coach' | 'build-skill'`):

- **coach** — the user's own prompt streams through the harness (session-resuming).
- **build-skill** — the renderer sends a detected candidate's NORMALIZED evidence (`SkillsProseRequest` shape); the MAIN process builds the SKILL.md authoring prompt from that evidence, so raw transcripts and session text never reach the model. The streamed markdown becomes an interactive draft card in the thread (Copy / Save… / Dismiss), replacing the old one-shot `skills:prose` channel and the standalone draft-prose runner.

The old `skills:prose` handler, `createSkillsDraftRunner`, and their preload/api wrappers are removed — build-skill is a mode, not a channel.

### 3. No consent gate

The `agents_consent_config` ledger table, `get/setAgentsConsent`, the `agents:consent:get/set` handlers, the main-side runner gates, the renderer's `agentsConsent` setting + Privacy pane toggle, and the coach-store's `consentRequired/pendingRun/grant/decline` machinery are **removed entirely**. ADR 0012's addendum paragraph is superseded by this ADR for the agents surface. Harness runs are user-initiated from an explicit click; the harness is the user's own CLI running in a user-picked workspace (see below).

### 4. User-picked workspace

A new `coach:pick-workspace` IPC opens the OS directory picker — the dialog IS the authorization for where the harness works. The main process never guesses a path.

### 5. Build-skill candidate pool stays detection-driven

The unified store keeps the scoped `skills:view` detection payload as the build-skill candidate pool (frequency × spread gate unchanged, Settings › Skills). Drafts and dismissals keep their ledger behavior; dismissal still filters every fetch.

## Consequences

- One section, one store (message model), one run channel — the renderer drops the separate skills store and the half-built coach store.
- Every harness on the machine is usable for both coaching and skill-building with no gate; the app adds nothing between the user and their own tooling.
- The `coach:run` wire contract gains `mode` (+ optional `evidence`); `prompt` is now optional at the schema and required semantically for coach runs, required-by-construction for build-skill runs (main-side).
- ACP model selection remains unsupported (upstream), so the run carries no model requirement — informational only.
- Privacy documentation (ADR 0012) is updated in scope: the "consented exception" for agents is gone; the app's network surface is unchanged (pricing, FX, manual updates).
