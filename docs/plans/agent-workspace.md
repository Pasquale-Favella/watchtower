# Agent workspace implementation

Status: implementation in progress. Application service, driver, operational
store and dedicated worker prototypes are under test, but are not connected to
production execution. No workspace release or native protocol certification is
complete on this branch yet.

[Issue #178](https://github.com/Pasquale-Favella/watchtower/issues/178) owns the
requirements, agreed directions, work breakdown and acceptance gates. This file
records the starting sequence for implementation; the issue remains the planning
authority under [the tracker convention](../agents/issue-tracker.md).

## First implementation slices

1. M0.1 consolidates the domain and ownership ADR, glossary terms, identities and
   lifecycle invariants. Task, Conversation, AgentSession and AgentRun have
   separate meanings. WorkArtifact preserves the existing installer meaning of
   Artifact. No domain or persistence schema is implemented by this document.
2. M0.2 verifies the driver contract against Codex App Server, the Claude Agent
   SDK candidate and generic ACP. Record capabilities, request handling, native
   resume, interruption and cleanup per version, operating system and supported
   authentication mode. Scope, event streams and close/drain semantics belong in
   the first contract. Keep authenticated smoke tests separate from ordinary CI.
3. M0.1 and M0.2 converge on the domain, driver contract and conformance matrix
   before M0.3 validates operational persistence and recovery. M0.3 covers atomic
   command receipts, dispatch ambiguity, worker replacement, snapshot/replay and
   measured streaming limits in real Electron.

## Current implementation evidence

The 2026-10-29 driver checkpoint is published as `efa93ba`; operational storage
and the application service are published as `8ec99c3`, following `92068f5`.
The dedicated worker follow-up builds on `8ec99c3`. Exact published references
and subsequent checkpoints are recorded in
[PR #179](https://github.com/Pasquale-Favella/watchtower/pull/179). The evidence
below covers these prototypes, not a completed workspace release:

- The [driver spike](../research/agent-driver-conformance.md) covers Codex App
  Server, the Claude SDK candidate and generic ACP. Deterministic regressions
  cover early cancellation, stale turn identity, pending native requests,
  disconnects, uncertain mutations and native-session validation. Claude child
  environment passthrough is restricted; unrelated host secrets are excluded.
- The operational SQLite prototype has command receipts, dispatch intents,
  bounded event/snapshot reads, composite native identity and forward migrations.
  Twenty real-SQLite tests cover provisional-session admission, exact stored-path
  exclusion, retired worker epochs, native ownership, corrupt task data,
  file-backed reopen/recovery, event deduplication and terminal lifecycle updates.
  Indexed request state avoids transcript scans on each delta. Terminal events
  settle dispatch intents atomically, so completed Runs cannot block recovery.
- The application ExecutionService prototype owns native dispatch and ingestion
  in its own scope, with a concurrent-execution limit. It claims durable intent
  before native calls, validates driver/connection/session identity, loads exact
  resume identities, commits native events before publication, and never resends
  a replayed command. Fourteen tests cover receipt replay at capacity, launch and
  claim failures, uncertain delivery, early interruption, retrying failed native
  interrupts and explicit shutdown-deadline failure. These use fake drivers, not
  real native execution or renderer subscriptions.
- The dedicated workspace worker owns operational SQLite in a standalone Node
  thread. The official Effect RPC protocol exposes the eleven WorkspaceStore
  methods plus versioned readiness and shutdown, with authoritative schemas,
  sanitized errors, 64 concurrent requests, 1 MiB request and 4 MiB response
  limits. Admitted mutations drain before SQL closes and shutdown acknowledges.
  The scoped client implements the existing port without automatic reconnect,
  retry or resend. Initialization covers the entire handshake; shutdown has a
  configured deadline followed by a 250 ms native termination budget, and
  unconfirmed cleanup is reported rather than silently accepted.
  Seven real-thread integration tests cover the lifecycle, explicit worker
  replacement/recovery, startup and cleanup deadlines, invalid/oversized input
  and concurrency bounds. Three handler tests and eleven shared Schema tests
  pass. The production build includes a separate workspace-worker entry, but
  main, renderer and Coach do not use it yet.
- Full Vitest: 317 files passed, 3,530 tests passed and 5 skipped. All four
  TypeScript projects, Effect diagnostics and diagnostic fixtures, ESLint,
  Prettier and the Electron production build passed. Three real Electron smoke
  tests passed for boot/navigation, renderer lifetime and Operational log.
- Windows NSIS packaging and the packaged application verifier passed again
  with the new build entry, including boot, RPC/SQLite, MCP stdio/HTTP, export
  and configuration. These generic application checks do not exercise the new
  workspace worker inside the package or certify native drivers. Installer
  install/uninstall acceptance requires a disposable hosted runner and was not
  run locally. macOS/Linux packaging and native-driver execution remain unverified.

This does not complete M0.2, M0.3, M1.1 or M1.3. Production workspace-worker
composition and replacement supervision, service/driver routing and RPC,
durable queue/response commands, admission and backlog budgets, text batching,
fault injection, streaming measurements and Coach migration remain open. A
reported shutdown timeout retains uncertainty; it does not establish that an
uncooperative native process was terminated.
Exact stored-path exclusion is not canonical filesystem identity: case aliases,
symlinks and junctions still require the checkout resolver. Authenticated native
turns, permitted Claude distribution and packaged-driver/cross-platform checks
remain release gates. Ordinary tests make no paid inference calls.

## Constraints for these slices

- Follow [ADR 0038](../adr/0038-engine-core-and-desktop-adapters.md). Core owns
  domain policy and ports; infrastructure implements IO and Harness protocols;
  platform adapters compose runtimes and own native resources. Shared schemas
  define wire contracts; renderer hooks consume them.
- Preserve the implemented Effect Atom and typed RPC boundaries. Each isolate
  retains its application-owned runtime; UI subscriptions do not own execution.
- Generalize execution so Coach & Skills becomes a consumer of the common
  service. Any temporary compatibility adapter needs a removal condition.
- Use separate operational storage with one writer in a dedicated workspace
  worker as the agreed direction. Main retains native supervision, and the
  existing db-worker retains ledger ownership. M0.3 must validate this topology.
- Keep sessions durable and connections volatile. Reuse is driver-specific;
  multiplexing, idle expiry and failure isolation require evidence.
- Persist critical facts before dispatch or publication. Text batching needs
  byte and age bounds; flush intervals alone do not bound loss under backlog.
  An uncertain native dispatch cannot be blindly retried after a crash.
- Default to exclusive-write admission for managed checkouts and isolated
  worktrees for independent writers. Report which restrictions are enforced and
  which are advisory; worktrees do not provide filesystem sandboxing.
- Keep managed execution independent of collector and ledger availability.
  Correlation preserves composite identity, provenance and usage semantics;
  heuristic matches must not change monetary totals automatically.
- Treat the supported Claude authentication/distribution route as an open gate.
  An explicit user API key is the initially verifiable route; subscription use
  remains a goal, and a BYOK-only product scope is not assumed.

## Completion evidence

Record results in the issue and pull request for the exact tested revision.
Architectural agreement does not complete an ADR, certify a protocol or prove
packaged behavior. Keep the implementation PR in draft until its agreed scope
passes the issue's applicable gates. Move deferred scope to tracked follow-ups
before marking the parent issue complete.
