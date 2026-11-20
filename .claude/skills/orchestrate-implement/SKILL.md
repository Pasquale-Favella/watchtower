---
name: orchestrate-implement
description: Implement a multi-slice plan by fanning independent vertical slices out to parallel implement subagents, verifying with parallel review subagents, then integrating, committing per slice, and running full verification.
disable-model-invocation: true
---

# Orchestrate Implement

A plan has arrived — multiple vertical slices (from `/to-tickets`, a PR plan, or an ADR rollout) that no single session should grind through sequentially. The orchestrator (this session) fans the independent slices out to parallel implement subagents, verifies with parallel review subagents, then integrates and commits. Subagents do; the orchestrator decides.

## When to use

Use when the work splits into two or more slices that fit in one fresh agent session each and touch disjoint files. Do NOT use for a single slice (just `/implement` it), for slices with blocking edges between them (sequence those as waves — run the frontier in parallel, then the newly unblocked), or for wide mechanical refactors (sequence as expand–contract per `/to-tickets`).

## Roles

- **Orchestrator** (this session): defines slice boundaries, verifies disjointness, writes each subagent's brief, integrates results, fixes review findings, commits per slice, runs full verification, updates the tracker. The orchestrator is the only one who commits, pushes, or writes the tracker.
- **Implement subagent**: owns exactly one slice. Loads `/implement`. Reports back; never commits.
- **Verify subagents**: one loads `/code-review` (read-only, reviews the diff since a fixed point), one loads `/code-simplifier` (scoped to the slice's touched files). Report back; the simplifier may edit within its scope but never commits.

## Process

### 1. Recon and slice

Read the plan and grep the codebase for the real call sites, seams, and tests — scopes must come from evidence, not memory. Carve slices along file boundaries: each slice names its **owned files** (create/modify) and its **forbidden files** (everything else, especially other slices' files). Slices in one wave must be disjoint; anything shared (a deletion both need, a composition root both join) belongs to exactly one slice or a later wave. Size each slice to one fresh session; if a slice won't fit, split it before fanning out.

### 2. Brief the implement subagents

Launch one subagent per frontier slice in a single parallel batch. Every brief contains the same contract, specialized with the slice's scope:

- Skill to load first (`/implement`), then the repo's must-read docs (Effect guide, domain docs, ADRs in the area).
- Owned files + forbidden files, with the rule: additive alongside legacy code where a migration is in flight; never alter existing exports or behavior outside the slice.
- The pattern to mirror: point at the already-merged exemplar files and tests, not prose — subagents copy shapes, not descriptions.
- The gotchas already paid for in this repo (API renames, test-clock patterns, import rules) so no wave re-learns them.
- Invariants the slice must hold (single-writer ownership, contract sources of truth, what stays out of scope) and each adapter's removal condition where the slice adds or retires one.
- Scoped verification only: typecheck, the slice's test files plus named regression files, linter and formatter on touched files. Never repo-wide commands, never commits, never tracker writes.
- Report-only return: per-file changes, verification outputs with counts, design decisions, removal conditions, follow-ups. Stop after reporting.

### 3. Integrate

Confirm the returned slices are disjoint and the tree holds only intended files (`git status`). Resolve any overlap yourself — never launch a third agent into a conflict. Apply small follow-ups (dead code the slice orphaned, stale comments it left) directly when they are obviously safe and covered by the slice's tests.

### 4. Verify in parallel

Launch the review and simplifier subagents in one batch over the integrated tree: the reviewer reads the diff since the wave's fixed point (the commit the wave started from) along Standards and Spec axes and reports blocking vs non-blocking findings with `file:line` references; the simplifier refines only the wave's touched files, behavior-preserving, then re-runs the scoped verification. Warn the simplifier off formatter writes to any file that already fails the formatter check at HEAD (check-only there). Fix blocking findings yourself; fold worthwhile nits in or record them as follow-ups.

### 5. Commit, verify fully, update the tracker

Commit per slice (one logical change per commit, sponsor message matching repo style), then run the full gates the repo requires — full typecheck, full test suite, build, and e2e/packaged checks where the plan demands them. Report honestly what ran green and what was deferred and why. Finally update the plan's living document (the PR or issue comment the rollout tracks in): edit it in place so the thread keeps a single plan, and record verification results per slice. Never open a second planning thread beside the first.
