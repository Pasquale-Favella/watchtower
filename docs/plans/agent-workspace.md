# Agent workspace implementation

Status: implementation in progress. Application service, driver, operational
store, worker, supervisor and checkout-resolver prototypes are under test, but
are not connected to production execution. No workspace release or native protocol certification is
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
The dedicated worker follow-up builds on `8ec99c3`. The checkout resolver,
driver registry, durable deliveries and queue, worker supervisor and delta
coalescer follow `2de0a02`. Exact published references
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
- The checkout resolver derives canonical identity from native realpath, so
  case, symlink and junction aliases collapse, and from the canonical common
  Git directory, so same-leaf repositories differ and linked worktrees map to
  their main checkout. Worktree creation refuses non-empty targets and branch
  collisions; removal refuses dirty and main checkouts. Twenty-five tests use
  real Git repositories. Store admission does not consume it yet.
- ExecutionService routes each claim through an AgentDriverRegistry. Unknown
  drivers settle as launch failures before native calls; connections remain
  scoped per Run. Codex, Claude and ACP are registered; ACP command
  configuration is not forwarded yet.
- Migration 6 persists request responses and steering as receipted intents
  before native delivery, rejects stale requests and settles explicit
  accepted, failed or uncertain outcomes. Worker recovery marks pending
  deliveries of the retired epoch uncertain without resending. A durable
  follow-up queue promotes the next Run atomically only when its Conversation is
  idle. Snapshots are bounded; cursor pages expose full queue and delivery
  histories within worker frames. Worker protocol version 3 exposes these.
- A workspace-worker supervisor provides a stable store over the current worker,
  bounded replacement with backoff, one recovery per replacement and typed
  failure without resend for in-flight calls. Unconfirmed cleanup becomes a
  terminal unavailable state instead of a second writer. It is not started by
  the application yet.
- A pure delta coalescer bounds buffered text by bytes, age and event count and
  flushes before every critical event. The service does not use it yet.
- Full Vitest: 321 files passed, 3,621 tests passed and 5 skipped. All four
  TypeScript projects, Effect diagnostics and diagnostic fixtures, ESLint,
  Prettier and the Electron production build passed. Electron smoke and
  packaging checks were last run on `2de0a02`.
- Windows NSIS packaging and the packaged application verifier passed again
  with the new build entry, including boot, RPC/SQLite, MCP stdio/HTTP, export
  and configuration. These generic application checks do not exercise the new
  workspace worker inside the package or certify native drivers. Installer
  install/uninstall acceptance requires a disposable hosted runner and was not
  run locally. macOS/Linux packaging and native-driver execution remain unverified.

## Integration checkpoint, 2026-10-30

Five reviewed commits build on `937eb34`:

- `c4ff6e2` adds store-issued increasing owner epochs and atomic recovery of prior
  dispatch and delivery intents. Migration 7 persists the counter, and the
  supervisor publishes only the epoch committed by its new worker. Legacy
  stores that have never allocated an epoch retain the existing caller-number
  compatibility path; after allocation, invented claim epochs are rejected.
  Native session binding is separate from turn acceptance. Early requests can
  be persisted and answered while `submit` waits, without recording an accepted
  turn. Worker protocol version 5 exposes both operations.
- `abe6299` adds an injected, immutable named connection catalog. The resolver
  validates driver identity and forwards exact ACP command and argument
  configuration. Invalid catalogs fail through the Layer error channel. Secret
  references are explicitly unsupported until a driver can resolve them; they
  cannot silently select ambient credentials. Discovery-backed catalog hydration
  and persisted connection settings remain open.
- `2611342` adds the application event consumer over the existing delta policy.
  It awaits serial commits, keeps one upstream pull alive across deadline
  waits, and flushes text before critical events, at the age limit, and on end
  or failure. This bounds coalescer state; it does not guarantee a storage
  latency under overload or replace native queue limits.
- `6db3b2a` adds project registration through CheckoutResolver. Canonical main
  checkout identity is persisted even when the selected directory is an alias
  or linked worktree. Tests combine real Git and SQLite to distinguish same-name
  repositories and exclude concurrent writes through aliases. This application
  command is not connected to production RPC yet. Duplicate project reuse,
  registration receipts and checkout revalidation before dispatch remain open.
- `1066973` connects the consumer and connection resolver to ExecutionService.
  Responses and steering are recorded before native delivery, and promoted
  follow-ups go directly through claim and dispatch rather than `start`.
  Application-owned control jobs survive caller cancellation. Both run and
  waiting admission are bounded; shutdown includes control jobs in its deadline
  and reports unresolved cleanup. Ingestion failure or EOF also stops a pending
  native submission conservatively. Queue promotion is explicit; automatic
  continuation and its identity allocation remain open.

The nine focused test files pass 125 tests. The full suite passes 324 files,
3,655 tests, with 5 skipped. All four TypeScript projects, Effect diagnostics and
fixtures, Prettier and the production Electron build pass. ESLint has zero
errors and the unchanged 1,409 existing warnings. Native turns remain opt-in;
these checks make no paid inference calls.

The subsequent three-test Electron check is not green. Its Operational log
scenario reaches a successful process exit, but the Playwright close request
does not settle within the existing cleanup deadline. Diagnosis is in progress;
the assertion and timeout have not been weakened. This checkpoint does not
replace the historical successful Electron and packaging evidence at `2de0a02`.

This does not complete M0.2, M0.3, M1.1, M1.2 or M1.3. Production composition of
the supervisor, connection catalog, registry and service, replacement ordering
with active native work, byte-aware event pagination, project/task read
contracts, workspace RPC, fault injection, streaming/load measurements and Coach
migration remain open. A
reported shutdown timeout retains uncertainty; it does not establish that an
uncooperative native process was terminated.
Worktrees and the resolver do not provide filesystem sandboxing or exclude
external writers. Authenticated native
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
