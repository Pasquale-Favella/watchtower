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
5. Limits: depth is 1, so a Delegated Task cannot start a Delegation, and a Run with no depth left is offered no orchestration tools. A parent Run has at most 4 active Delegations, counting resumed ones. These are fixed in code.
6. A Delegation wake is a message queued into the parent Conversation with origin `delegation` on the existing follow-up queue. The existing hold rule applies: when the parent's last Run did not complete, the wake waits for the user. When the parent is idle and its last Run completed, the wake starts the parent Run.
7. `delegation_start` with `mode: wait` blocks up to `timeoutMs` (maximum 45 seconds). The waiter is registered before the child launches, so a child that settles during launch is still handed to the caller. A wait that times out keeps the result on its way to the parent through the wake.
8. A child's approvals stay in the child Task: the parent Agent cannot approve them. The parent may answer a child's question through `delegation_send`, and may read the child's latest messages and open question through `delegation_read`. Pending requests are mirrored on the Delegation for the UI. `delegation_send` steers a running child, answers its open question, or resumes a settled child with a follow-up Run in the child's own Conversation. A resume re-opens the Delegation under the calling Run, inside the same transaction that checks the parent is live and below its limit; its access mode is at most both the caller's and the child's previous mode, and its settlement queues a new wake. A send with a client request id repeats the action of its first call.
9. `delegation_cancel` is available to the direct parent. It requests cancellation, interrupts the child Run, drops its queued follow-ups, and disposes its wake. A cancelled Delegation settles as `cancelled`. A child whose Run was never claimed has no worker to report back, so its cancel settles the Delegation at once. Stopping a parent Run interrupts its running Delegations.
10. Delegation records and wake state live in the workspace SQLite store (migration 16). Recovery after a restart settles children whose Runs ended, re-queues wakes that are still pending, and settles a child whose Run was queued but never claimed as failed (`launch-failed`) with a wake for the parent. Recovery runs before the workspace opens when any Delegation is unsettled or any wake is pending, so no caller reads a child that is still queued after its Run ended. A wake's notice comes from the parent Run it queues, so it reaches the timeline whether or not that Run can start: promoting the queued Run and failing its launch advance the event watermark that bounds the timeline, since no driver event publishes those. A never-claimed child is not re-dispatched: the parent Run that asked for it has ended, so launching it after a restart would act with no caller. A child's launch and a cancel of it take the Delegation lock together, so a cancel that lands first prevents the launch.
11. The orchestration tools are `delegation_capabilities`, `delegation_start`, `delegation_status` (one Delegation, or a listing without an id), `delegation_read`, `delegation_send` and `delegation_cancel`. The reading tools are allowed without an approval prompt where the driver supports a per-tool allowance. Claude does. Other tools prompt under approval-required. When the endpoint is attached, the Run also receives a short guidance block on when to delegate: the Claude system prompt append, Codex developer instructions, or the first ACP prompt of a session.
12. Isolation defaults to `shared`, which reuses the parent checkout. `worktree` is opt-in and creates a worktree from the parent's branch.
13. Native harness children are unchanged (ADR 0042).

### Wake states

`pending` means the result is settled and the wake is queued or held but not yet in the parent Conversation. `delivered` means the parent's next turn carries the wake message. `disposed` means no wake is owed: a `wait` caller received the result directly, or the Delegation was cancelled. A `wait` that times out upgrades the record's wake from `settledOnly` to `always`, so the record shows the wake that settlement will queue. The desktop UI treats a settled Delegation with `pending` wake state and no active parent Run as held.

## Consequences

- Cross-harness delegation works without changing how native subagents render.
- Child Tasks are real Tasks. The sidebar does not list them: their parent's row rolls up their pending approvals, questions and running work, and opening a child reveals its parent row. A child whose parent is archived or missing is listed on its own. `listTasks` applies the same rule unless `includeDelegated` is set.
- Tool results are compact: an id, status, bounded result and a `next` hint. Prompts and results never enter the operational log.
- Plan-mode narrowing is not applied: Watchtower has no interaction mode to narrow.

## Alternatives rejected

- Store delegations in the side-chat JSON store: no run-level link, no outbox, no recovery.
- Let the parent Agent answer child approvals: the parent could widen a child's authority past the user's decision. Questions carry no authority, so the parent may answer those.
- Use only native subagents: cannot cross harnesses.
