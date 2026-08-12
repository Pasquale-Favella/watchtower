# ADR 0021 — One coach agent, two scopes: build-skill deleted, skills crafted conversationally

- Status: accepted
- Date: 2026-08-12
- Domain: agents (Coach & Skills surface), skills (detection/draft seam), store (models cache)
- Supersedes: ADR 0017's mode-tagged run design (`CoachMode = 'coach' | 'build-skill'`),
  the renderer-driven evidence payload (`SkillsProseRequest`), and the mid-thread draft
  card lifecycle. The unified single section (ADR 0017), the no-consent decision, and the
  ledger MCP surface (ADRs 0019/0020) are unchanged.

## Context

ADR 0017 shipped a mode-tagged Coach & Skills chat: `coach` runs streamed the user's own
prompt, and `build-skill` runs turned a DETECTED CANDIDATE's normalized evidence into a
SKILL.md through the main-side `buildProsePrompt`, landing an interactive draft card
(Copy / Save… / Dismiss) mid-thread. Pathfinder map 58 and its roast (#59) concluded the
skill side was misaligned with how the user actually thinks: the candidate-picker +
one-shot prose flow was a *picker one-shot*, while the product wants *an interactive
crafting conversation* where the agent proposes, discusses, and writes the skill with the
user — pulling evidence from the ledger MCP mid-conversation.

Two more observations made the picker flow removable rather than replaceable:

1. **The agent already has the data.** ADRs 0019/0020 give every run read-only access to
   the user's FULL usage history through the `watchtower-ledger` MCP server
   (`ledger_skills`, `ledger_calls`, `ledger_scope`). A conversational skill request needs
   no spawn-time evidence payload — the agent discovers the real pattern itself.
2. **A draft card is a dead end, not a review step.** The SKILL.md the agent authors is a
   plain markdown answer. Rendering it as a special card with its own save/dismiss
   machinery duplicated what Copy already does on any message.

## Decision

### 1. One agent, two scopes — the mode is gone

`coachRunRequestSchema` loses `mode` and `evidence`; `CoachMode`,
`skillsProseRequestSchema`/`SkillsProseResult`, and `buildProsePrompt` are deleted. Every
run is a plain mode-less coach run: the user's own prompt streams through the harness,
whether it is a coaching question or a skill request. A smuggled `mode`/`evidence` is
stripped by zod, never reaching the runner.

### 2. The one briefing defines both scopes

`buildLedgerBriefing` is the single role definition for the one agent: it names the TWO
scopes (coaching analysis and skill authoring), the ledger tools and their per-tool
selection guidance, the answer contract (state the window, USD + tables, query only what
the question needs, never invent), the skill-authoring scope (evidence-first: work from
`ledger_skills`/`ledger_calls`, quote the real invocations verbatim, keep the skill
lean; the SKILL.md SHAPE is deliberately left to the harness's own conventions — the
prompt hands over the material, never a template), and the non-negotiables. The briefing still rides only a conversation's first run and only when
the ledger MCP server is actually injected. The MCP prompt surface keeps just
`coach-orient` (the `build-skill` prompt template is deleted).

### 3. Suggested-skill chips are chat-starters

The welcome screen keeps the detection-driven chips (the frequency × spread gate in
Settings › Skills detection, ADR 0017), but clicking one sends a NORMAL coach run whose
prompt (`craftSkillPrompt`, renderer) names the pattern's evidence — frequency, spread,
cost, the raw sample, the concrete evidence sessions — and asks the harness to author
the SKILL.md in its own format, pointing it at `ledger_skills`/`ledger_calls` for the
verbatim invocations. The answer streams into the
thread as plain markdown: no build-skill mode, no draft card. `dismiss`, `sendBuildSkill`,
and the draft-card plumbing are deleted.

### 4. Per-harness model cache

The store keeps the models/modes each harness declared through the ACP handshake (ADR
0018) in a per-harness cache (`modelsByKind`) that ALSO holds the user's picks. A
successful probe — or a run's session event — writes the cache; a failed probe never
does, so unavailable agents are retried. Switching harnesses restores a previously-probed
set and the user's picks INSTANTLY (no IPC, no agent spawn), and a probe that answers
after a switch is cached for its kind instead of dropped. `resetSession` restores the
current harness's cached set, so the pickers never go blank on a new conversation.

## Consequences

- The renderer never sends a mode or evidence; the wire contract is simpler and the
  `build-skill` requirement-check in the runner is gone.
- A skill request is indistinguishable from any other message to the harness — the same
  session, the same thread, the same resume semantics. The user crafts skills by talking,
  exactly like the map's destination.
- A harness-authored SKILL.md renders as an ordinary markdown answer, copyable like any
  other; Save (the OS dialog) remains available on the message copy path.
- The chip surface still surfaces WHAT the detector found (frequency, spread, cost) so
  the user does not have to guess what is worth turning into a skill — but the flow is
  conversation, not picker.
- The agent prompt is the product's voice: the briefing and `craftSkillPrompt` carry the
  same authoring stance (evidence-first, shape left to the harness) and are kept in sync
  (a NOTE in both files cross-references them), so later turns — where the first-run
  briefing is not restated — still craft correctly.
- The per-harness model cache removes a class of UX jank (picker blanks + re-probing on
  provider switch) without changing the wire: what the pickers show pre-chat is exactly
  what the first run's session event would declare anyway.
