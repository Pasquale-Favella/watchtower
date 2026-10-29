# Agent workspace implementation

Status: planning. No workspace implementation or protocol certification is
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
