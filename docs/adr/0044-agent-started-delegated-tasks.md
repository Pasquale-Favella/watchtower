# Agent-started Delegated Tasks as linked Tasks

Status: accepted
Related: ADR 0039 (Task, Conversation and Run identity), ADR 0041 (per-dispatch loopback credentials), ADR 0042 (native delegated agents and side chats).

## Context

An Agent Run needs to hand work to another agent, possibly on a different Harness Connection, and to receive the result without the user relaying it. Harness-native subagents cannot cross harnesses, and side chats are user-initiated and return nothing to the parent.

## Decision

1. An Agent Run starts a child by calling an orchestration tool. The child is a new Task in the parent's Project with its own Conversation, Agent Sessions and Runs. A Delegation row links it to the parent Run. The parent Task's status is unaffected.
2. Any Harness Connection may be a target, including ACP connections. The orchestrator endpoint is attached over HTTP MCP when the agent advertises it, and otherwise through a stdio bridge that forwards to the same loopback endpoint. A connection that can neither attach it reports `delegation` as unsupported with a restriction.
3. The orchestrator endpoint is per dispatch, as ADR 0041 specifies: a random bearer token on 127.0.0.1, acquired in the Driver Connection scope. Its caller identity (Project, Task, Conversation, Run and access mode) is fixed when the endpoint is created. Tool arguments cannot change identity.
4. A child's access mode is at most its parent Run's access mode. An omitted request inherits and steps down when the target lacks the mode. An explicit unsupported request is refused, and an explicit escalation is refused.
5. Limits: depth is 1, so a Delegated Task cannot start a Delegation, and the start tool is not offered to it. A parent Run has at most 4 active Delegations. These are fixed in code.
6. A Delegation wake is a message queued into the parent Conversation with origin `delegation` on the existing follow-up queue. The existing hold rule applies: when the parent's last Run did not complete, the wake waits for the user. When the parent is idle and its last Run completed, the wake starts the parent Run.
7. `delegation_start` with `mode: wait` blocks up to `timeoutMs` (maximum 45 seconds). A wait that times out keeps the result on its way to the parent through the wake.
8. A child's approvals and questions stay in the child Task. The parent Agent cannot answer or approve them. Pending requests are mirrored on the Delegation for the UI.
9. `delegation_cancel` is available to the direct parent. It requests cancellation, interrupts the child Run, drops its queued follow-ups, and disposes its wake. A cancelled Delegation settles as `cancelled`. Stopping a parent Run interrupts its running Delegations.
10. Delegation records and wake state live in the workspace SQLite store (migration 16). Recovery after a restart settles children whose Runs ended and re-queues wakes that are still pending.
11. Read-only orchestration tools (`delegation_capabilities`, `delegation_status`, `delegation_list`) are allowed without an approval prompt where the driver supports a per-tool allowance. Claude does. Other tools prompt under approval-required.
12. Isolation defaults to `shared`, which reuses the parent checkout. `worktree` is opt-in and creates a worktree from the parent's branch.
13. Native harness children are unchanged (ADR 0042).

### Wake states

`pending` means the result is settled and the wake is queued or held but not yet in the parent Conversation. `delivered` means the parent's next turn carries the wake message. `disposed` means no wake is owed: a `wait` caller received the result directly, or the Delegation was cancelled. The desktop UI treats a settled Delegation with `pending` wake state and no active parent Run as held.

## Consequences

- Cross-harness delegation works without changing how native subagents render.
- Child Tasks are real Tasks. The sidebar shows them only nested under their parent, and `listTasks` excludes them unless `includeDelegated` is set.
- Tool results are compact: an id, status, bounded result and a `next` hint. Prompts and results never enter the operational log.
- Plan-mode narrowing is not applied: Watchtower has no interaction mode to narrow.

## Alternatives rejected

- Store delegations in the side-chat JSON store: no run-level link, no outbox, no recovery.
- Let the parent Agent answer child approvals: the parent could widen a child's authority past the user's decision.
- Use only native subagents: cannot cross harnesses.
