import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import { WORKSPACE_WORKER_PROTOCOL_VERSION, WorkspaceWorkerRpcGroup } from '../src/shared/rpc/workspace-worker.js'
import {
  agentSessionSchema,
  conversationSchema,
  projectSchema,
  taskSchema,
  workspaceCheckoutSchema,
} from '../src/shared/schemas/workspace.js'
import {
  dispatchClaimSchema,
  dispatchFailureCommandSchema,
  recordDriverEventCommandSchema,
  workspaceSnapshotSchema,
  WorkspaceStoreError,
} from '../src/shared/schemas/workspace-store.js'

describe('agent workspace domain schemas', () => {
  it('validates repository identity and explicit checkout identity independently of display names', () => {
    const project = {
      id: 'project-1',
      name: 'same-name',
      repositoryIdentity: 'repo:8c9150',
      createdAt: '2026-10-29T10:00:00Z',
      updatedAt: '2026-10-29T10:00:00Z',
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(projectSchema)(project))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(projectSchema)({ ...project, repositoryIdentity: '' }))).toBe(
      true,
    )
    expect(Result.isFailure(Schema.decodeUnknownResult(projectSchema)({ ...project, id: '  ' }))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(projectSchema)({ ...project, createdAt: 'yesterday' }))).toBe(
      true,
    )

    const checkout = {
      id: 'checkout-main',
      projectId: project.id,
      kind: 'main',
      path: 'C:/work/repo',
      createdAt: project.createdAt,
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(workspaceCheckoutSchema)(checkout))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(workspaceCheckoutSchema)({ ...checkout, path: '' }))).toBe(true)
  })

  it('keeps task lifecycle separate from conversations and native sessions', () => {
    const task = {
      id: 'task-1',
      projectId: 'project-1',
      title: 'Implement feature',
      description: 'A durable objective',
      status: 'inReview',
      createdAt: '2026-10-29T10:00:00Z',
      updatedAt: '2026-10-29T10:01:00Z',
    }
    const conversation = {
      id: 'conversation-1',
      taskId: task.id,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(taskSchema)(task))).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(conversationSchema)(conversation))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(conversationSchema)({ ...conversation, taskId: '' }))).toBe(true)
  })

  it('requires native identity and positive generation for a persisted session', () => {
    const session = {
      id: 'session-1',
      taskId: 'task-1',
      conversationId: 'conversation-1',
      checkoutId: 'checkout-1',
      connectionId: 'codex-local',
      driverId: 'codex-app-server',
      nativeSessionId: 'native-77',
      generation: 2,
      status: 'active',
      createdAt: '2026-10-29T10:00:00Z',
      updatedAt: '2026-10-29T10:01:00Z',
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(agentSessionSchema)(session))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(agentSessionSchema)({ ...session, generation: 0 }))).toBe(true)
  })

  it('requires project and workspace path scope on a dispatch claim', () => {
    const claim = {
      runId: 'run-1',
      projectId: 'project-1',
      taskId: 'task-1',
      conversationId: 'conversation-1',
      ownerEpoch: 1,
      provisionalAgentSessionId: 'session-1',
      driverId: 'codex-app-server',
      connectionId: 'codex-local',
      checkoutId: 'checkout-1',
      workspacePath: 'C:/work/repo',
      generation: 2,
      prompt: 'Implement the task',
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(dispatchClaimSchema)(claim))).toBe(true)

    const withoutProjectId: Record<string, unknown> = { ...claim }
    delete withoutProjectId.projectId
    expect(Result.isFailure(Schema.decodeUnknownResult(dispatchClaimSchema)(withoutProjectId))).toBe(true)

    const withoutWorkspacePath: Record<string, unknown> = { ...claim }
    delete withoutWorkspacePath.workspacePath
    expect(Result.isFailure(Schema.decodeUnknownResult(dispatchClaimSchema)(withoutWorkspacePath))).toBe(true)
  })

  it('validates dispatch owner and generation alongside typed native driver events', () => {
    const command = {
      ownerEpoch: 3,
      generation: 2,
      eventId: 'event-1',
      occurredAt: '2026-10-29T10:00:00Z',
      event: { kind: 'toolStarted', toolCallId: 'tool-call-1', name: 'Search', input: '{}' },
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(recordDriverEventCommandSchema)(command))).toBe(true)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(recordDriverEventCommandSchema)({ ...command, ownerEpoch: 0 })),
    ).toBe(true)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(recordDriverEventCommandSchema)({ ...command, generation: 0 })),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(recordDriverEventCommandSchema)({
          ...command,
          event: { kind: 'toolStarted', toolCallId: 'tool-call-1', name: '' },
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(recordDriverEventCommandSchema)({
          ...command,
          event: { kind: 'usageReported', semantics: 'delta', scope: 'run', inputTokens: -1 },
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(recordDriverEventCommandSchema)({
          ...command,
          event: { kind: 'unrecognizedNativeEvent', payload: {} },
        }),
      ),
    ).toBe(true)
  })

  it('limits dispatch failure reasons to bounded categories', () => {
    const failure = {
      ownerEpoch: 3,
      occurredAt: '2026-10-29T10:00:00Z',
      outcome: 'failed',
      reason: 'launch-failed',
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(dispatchFailureCommandSchema)(failure))).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(dispatchFailureCommandSchema)({
          ...failure,
          reason: 'ENOENT: private path C:/Users/example/.ssh/id_rsa',
        }),
      ),
    ).toBe(true)
  })

  it('decodes snapshot runs with the agent run contract', () => {
    const snapshot = {
      task: { id: 'task-1', projectId: 'project-1', title: 'Implement task', status: 'open' },
      runs: [
        {
          id: 'run-1',
          taskId: 'task-1',
          attempt: 1,
          generation: 1,
          status: 'queued',
          submittedAt: '2026-10-29T10:00:00Z',
        },
      ],
      highWatermark: 0,
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(workspaceSnapshotSchema)(snapshot))).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(workspaceSnapshotSchema)({
          ...snapshot,
          runs: [{ ...snapshot.runs[0], status: 'unrecognized-status' }],
        }),
      ),
    ).toBe(true)
  })

  it('exposes exactly the workspace store operations plus readiness and shutdown', () => {
    expect([...WorkspaceWorkerRpcGroup.requests.keys()].sort()).toEqual(
      [
        'workspace-worker:ready',
        'workspace-worker:registerProject',
        'workspace-worker:createTask',
        'workspace-worker:beginRun',
        'workspace-worker:claimDispatch',
        'workspace-worker:acknowledgeDispatch',
        'workspace-worker:recordDriverEvent',
        'workspace-worker:failDispatch',
        'workspace-worker:requestInterrupt',
        'workspace-worker:recoverWorker',
        'workspace-worker:pageEvents',
        'workspace-worker:readTaskSnapshot',
        'workspace-worker:shutdown',
      ].sort(),
    )
  })

  it('requires positive worker epochs and a nonempty native session identity', () => {
    const claimDispatch = WorkspaceWorkerRpcGroup.requests.get('workspace-worker:claimDispatch')
    const acknowledgeDispatch = WorkspaceWorkerRpcGroup.requests.get('workspace-worker:acknowledgeDispatch')
    if (!claimDispatch || !acknowledgeDispatch) throw new Error('Workspace dispatch RPC is missing')

    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(claimDispatch.payloadSchema)({
          runId: 'run-1',
          ownerEpoch: 1,
          claimedAt: '2026-10-29T10:00:00Z',
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(claimDispatch.payloadSchema)({
          runId: 'run-1',
          ownerEpoch: 0,
          claimedAt: '2026-10-29T10:00:00Z',
        }),
      ),
    ).toBe(true)

    const acknowledgement = {
      runId: 'run-1',
      acknowledgement: {
        ownerEpoch: 1,
        nativeSessionId: 'native-session-1',
        acknowledgedAt: '2026-10-29T10:00:00Z',
      },
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(acknowledgeDispatch.payloadSchema)(acknowledgement))).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(acknowledgeDispatch.payloadSchema)({
          ...acknowledgement,
          acknowledgement: { ...acknowledgement.acknowledgement, ownerEpoch: 0 },
        }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(acknowledgeDispatch.payloadSchema)({
          ...acknowledgement,
          acknowledgement: { ...acknowledgement.acknowledgement, nativeSessionId: '  ' },
        }),
      ),
    ).toBe(true)
  })

  it('bounds event paging, strips extra fields, and rejects generic op/args requests', () => {
    const pageEvents = WorkspaceWorkerRpcGroup.requests.get('workspace-worker:pageEvents')
    if (!pageEvents) throw new Error('Workspace event paging RPC is missing')

    for (const payload of [
      { afterSequence: 0, limit: 1 },
      { afterSequence: 7, limit: 500 },
    ]) {
      expect(Result.isSuccess(Schema.decodeUnknownResult(pageEvents.payloadSchema)(payload))).toBe(true)
    }
    for (const payload of [
      { afterSequence: -1, limit: 1 },
      { afterSequence: 0, limit: 0 },
      { afterSequence: 0, limit: 501 },
    ]) {
      expect(Result.isFailure(Schema.decodeUnknownResult(pageEvents.payloadSchema)(payload))).toBe(true)
    }

    expect(Schema.decodeUnknownSync(pageEvents.payloadSchema)({ afterSequence: 0, limit: 1, extra: true })).toEqual({
      afterSequence: 0,
      limit: 1,
    })
    expect(Result.isFailure(Schema.decodeUnknownResult(pageEvents.payloadSchema)({ op: 'pageEvents', args: {} }))).toBe(
      true,
    )
  })

  it('versions readiness and rejects unknown workspace error codes', () => {
    const ready = WorkspaceWorkerRpcGroup.requests.get('workspace-worker:ready')
    if (!ready) throw new Error('Workspace readiness RPC is missing')

    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(ready.successSchema)({ protocolVersion: WORKSPACE_WORKER_PROTOCOL_VERSION }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(ready.successSchema)({ protocolVersion: WORKSPACE_WORKER_PROTOCOL_VERSION + 1 }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(WorkspaceStoreError)({
          _tag: 'WorkspaceStoreError',
          code: 'unknown-code',
          message: 'Workspace operation failed',
        }),
      ),
    ).toBe(true)
  })
})
