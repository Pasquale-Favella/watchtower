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
  deliveryOutcomeSchema,
  dispatchClaimSchema,
  dispatchFailureCommandSchema,
  enqueueFollowUpCommandSchema,
  followUpReceiptSchema,
  promotedFollowUpSchema,
  queuedFollowUpPageSchema,
  queuedFollowUpPreviewSchema,
  queuedFollowUpSchema,
  recordDriverEventCommandSchema,
  recordRequestResponseCommandSchema,
  recordSteerCommandSchema,
  requestResponseIntentSchema,
  requestResponsePageSchema,
  settleDeliveryCommandSchema,
  steerIntentPageSchema,
  steerIntentSchema,
  workspaceCheckoutPageOptionsSchema,
  workspaceConversationPageOptionsSchema,
  workspaceEntityPageOptionsSchema,
  workspaceEventPageOptionsSchema,
  workspacePayloadPageOptionsSchema,
  workspacePendingRuntimeRequestPageOptionsSchema,
  workspaceReadPageOptionsSchema,
  workspaceSnapshotSchema,
  WorkspaceStoreError,
} from '../src/shared/schemas/workspace-store.js'

describe('agent workspace domain schemas', () => {
  it('requires durable registration and task receipt results on worker RPC', () => {
    const at = '2026-10-30T08:00:00Z'
    const registration = WorkspaceWorkerRpcGroup.requests.get('workspace-worker:registerProject')
    if (!registration) throw new Error('Missing registration RPC')
    const receipt = {
      commandId: 'register',
      project: { id: 'project', name: 'Project', repositoryIdentity: 'repo:one', createdAt: at, updatedAt: at },
      mainCheckout: { id: 'checkout', projectId: 'project', kind: 'main', path: 'C:/repo', createdAt: at },
      replayed: false,
      reused: true,
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(registration.successSchema)(receipt))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(registration.successSchema)(undefined))).toBe(true)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(registration.successSchema)({ ...receipt, reused: undefined })),
    ).toBe(true)
    const creation = WorkspaceWorkerRpcGroup.requests.get('workspace-worker:createTask')
    if (!creation) throw new Error('Missing task creation RPC')
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(creation.successSchema)({
          commandId: 'create',
          taskId: 'task',
          conversationId: 'conversation',
          replayed: true,
        }),
      ),
    ).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(creation.successSchema)(undefined))).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(registration.payloadSchema)({
          commandId: '',
          project: receipt.project,
          mainCheckout: receipt.mainCheckout,
        }),
      ),
    ).toBe(true)
  })

  it('validates every read limit, safe sequence range and bounded payload chunk cursor', () => {
    for (const schema of [workspaceEventPageOptionsSchema, workspaceConversationPageOptionsSchema]) {
      expect(
        Result.isSuccess(Schema.decodeUnknownResult(schema)({ afterSequence: 4, throughSequence: 4, limit: 500 })),
      ).toBe(true)
      for (const options of [
        { afterSequence: 5, throughSequence: 4, limit: 1 },
        { afterSequence: 0, limit: 501 },
        { afterSequence: -1, limit: 1 },
        { afterSequence: Number.MAX_SAFE_INTEGER + 1, limit: 1 },
        { afterSequence: 0, throughSequence: Number.MAX_SAFE_INTEGER + 1, limit: 1 },
      ])
        expect(Result.isFailure(Schema.decodeUnknownResult(schema)(options))).toBe(true)
    }
    for (const schema of [workspaceEntityPageOptionsSchema, workspaceCheckoutPageOptionsSchema]) {
      expect(Result.isSuccess(Schema.decodeUnknownResult(schema)({ limit: 50 }))).toBe(true)
      for (const limit of [0, 0.5, 51, Number.NaN])
        expect(Result.isFailure(Schema.decodeUnknownResult(schema)({ limit }))).toBe(true)
    }
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(workspacePendingRuntimeRequestPageOptionsSchema)({ afterSequence: 0, limit: 51 }),
      ),
    ).toBe(true)
    const reference = { kind: 'event', id: '1', digest: 'a'.repeat(64) }
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(workspacePayloadPageOptionsSchema)({ reference, afterOffset: 0, limit: 65536 }),
      ),
    ).toBe(true)
    for (const options of [
      { reference, afterOffset: -1, limit: 1 },
      { reference, afterOffset: 0, limit: 65537 },
      { reference: { ...reference, kind: 'dispatchIntent' }, afterOffset: 0, limit: 1 },
      { reference: { ...reference, digest: 'invalid' }, afterOffset: 0, limit: 1 },
    ])
      expect(Result.isFailure(Schema.decodeUnknownResult(workspacePayloadPageOptionsSchema)(options))).toBe(true)
  })

  it('validates bounded history cursors, page envelopes and compact queue previews', () => {
    for (const options of [{}, { afterPosition: 0, limit: 1 }, { afterPosition: 3, limit: 50 }]) {
      expect(Result.isSuccess(Schema.decodeUnknownResult(workspaceReadPageOptionsSchema)(options))).toBe(true)
    }
    for (const options of [{ afterPosition: -1 }, { afterPosition: 0.1 }, { limit: 0 }, { limit: 51 }]) {
      expect(Result.isFailure(Schema.decodeUnknownResult(workspaceReadPageOptionsSchema)(options))).toBe(true)
    }
    const empty = { items: [], total: 0, truncated: false, nextAfterPosition: null }
    for (const schema of [queuedFollowUpPageSchema, requestResponsePageSchema, steerIntentPageSchema]) {
      expect(Result.isSuccess(Schema.decodeUnknownResult(schema)(empty))).toBe(true)
      expect(Result.isFailure(Schema.decodeUnknownResult(schema)({ ...empty, total: -1 }))).toBe(true)
      expect(Result.isFailure(Schema.decodeUnknownResult(schema)({ ...empty, nextAfterPosition: 0 }))).toBe(true)
    }
    const preview = {
      commandId: 'queue',
      taskId: 'task',
      conversationId: 'conversation',
      issuedAt: '2026-10-29T10:00:00Z',
      position: 1,
      promptByteLength: 900000,
      promptPreview: 'Short preview',
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(queuedFollowUpPreviewSchema)(preview))).toBe(true)
    expect(
      Schema.decodeUnknownSync(queuedFollowUpPreviewSchema)({ ...preview, prompt: 'not exposed' }),
    ).not.toHaveProperty('prompt')
    expect(
      Result.isFailure(Schema.decodeUnknownResult(queuedFollowUpPreviewSchema)({ ...preview, promptByteLength: -1 })),
    ).toBe(true)
  })

  it('validates response and steering identity, owner epoch and generation', () => {
    const response = {
      commandId: 'respond',
      issuedAt: '2026-10-29T10:00:00Z',
      runId: 'run',
      ownerEpoch: 7,
      generation: 1,
      requestId: 'approval',
      decision: { kind: 'approve' },
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(recordRequestResponseCommandSchema)(response))).toBe(true)
    for (const invalid of [
      { ...response, ownerEpoch: 0 },
      { ...response, generation: 0 },
      { ...response, requestId: '' },
      { ...response, decision: { kind: 'yes' } },
    ]) {
      expect(Result.isFailure(Schema.decodeUnknownResult(recordRequestResponseCommandSchema)(invalid))).toBe(true)
    }
    const steer = {
      commandId: 'steer',
      issuedAt: response.issuedAt,
      runId: response.runId,
      ownerEpoch: 7,
      generation: 1,
      expectedNativeTurnId: 'native-turn',
      message: 'Focus',
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(recordSteerCommandSchema)(steer))).toBe(true)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(recordSteerCommandSchema)({ ...steer, expectedNativeTurnId: '' })),
    ).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(recordSteerCommandSchema)({ ...steer, message: ' ' }))).toBe(
      true,
    )
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(requestResponseIntentSchema)({
          ...response,
          state: 'uncertain',
          delivery: { outcome: 'uncertain' },
        }),
      ),
    ).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(steerIntentSchema)({ ...steer, state: 'pending' }))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(steerIntentSchema)({ ...steer, state: 'retrying' }))).toBe(true)
  })

  it('distinguishes local acceptance, native confirmation, failure and uncertainty', () => {
    for (const delivery of [
      { outcome: 'accepted' },
      { outcome: 'accepted', nativeConfirmation: 'confirmed' },
      { outcome: 'accepted', nativeConfirmation: 'unconfirmed' },
      { outcome: 'failed' },
      { outcome: 'uncertain' },
    ]) {
      expect(Result.isSuccess(Schema.decodeUnknownResult(deliveryOutcomeSchema)(delivery))).toBe(true)
      expect(
        Result.isSuccess(
          Schema.decodeUnknownResult(settleDeliveryCommandSchema)({
            ...delivery,
            ownerEpoch: 7,
            occurredAt: '2026-10-29T10:00:00Z',
          }),
        ),
      ).toBe(true)
    }
    expect(Result.isFailure(Schema.decodeUnknownResult(deliveryOutcomeSchema)({ outcome: 'retry' }))).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(deliveryOutcomeSchema)({ outcome: 'accepted', nativeConfirmation: 'probably' }),
      ),
    ).toBe(true)
    expect(
      Result.isFailure(
        Schema.decodeUnknownResult(settleDeliveryCommandSchema)({
          outcome: 'uncertain',
          ownerEpoch: 0,
          occurredAt: 'now',
        }),
      ),
    ).toBe(true)
  })

  it('validates ordered queue entries, override nulls and queue-specific receipts', () => {
    const queued = {
      commandId: 'queue',
      issuedAt: '2026-10-29T10:00:00Z',
      taskId: 'task',
      conversationId: 'conversation',
      prompt: 'Follow up',
      driverId: 'codex',
      connectionId: 'local',
      modelId: null,
      modeId: 'plan',
    }
    expect(Result.isSuccess(Schema.decodeUnknownResult(enqueueFollowUpCommandSchema)(queued))).toBe(true)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(enqueueFollowUpCommandSchema)({ ...queued, conversationId: '' })),
    ).toBe(true)
    expect(
      Result.isFailure(Schema.decodeUnknownResult(enqueueFollowUpCommandSchema)({ ...queued, driverId: '' })),
    ).toBe(true)
    expect(Result.isSuccess(Schema.decodeUnknownResult(queuedFollowUpSchema)({ ...queued, position: 1 }))).toBe(true)
    expect(Result.isFailure(Schema.decodeUnknownResult(queuedFollowUpSchema)({ ...queued, position: 0 }))).toBe(true)
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(followUpReceiptSchema)({
          commandId: queued.commandId,
          conversationId: queued.conversationId,
          acceptedAt: queued.issuedAt,
          replayed: false,
        }),
      ),
    ).toBe(true)
    expect(
      Result.isSuccess(
        Schema.decodeUnknownResult(promotedFollowUpSchema)({
          followUp: { ...queued, position: 1 },
          receipt: { commandId: 'start', runId: 'run', acceptedAt: queued.issuedAt, replayed: false },
        }),
      ),
    ).toBe(true)
  })

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
        'workspace-worker:bindNativeSession',
        'workspace-worker:acknowledgeDispatch',
        'workspace-worker:acquireOwnerEpoch',
        'workspace-worker:recordDriverEvent',
        'workspace-worker:failDispatch',
        'workspace-worker:requestInterrupt',
        'workspace-worker:recoverWorker',
        'workspace-worker:pageEvents',
        'workspace-worker:readWorkspacePayload',
        'workspace-worker:readTaskSnapshot',
        'workspace-worker:listProjects',
        'workspace-worker:getProject',
        'workspace-worker:listTasks',
        'workspace-worker:readTaskDetail',
        'workspace-worker:readConversationPage',
        'workspace-worker:listNativeAgentSessions',
        'workspace-worker:listPendingRuntimeRequests',
        'workspace-worker:recordRequestResponse',
        'workspace-worker:settleRequestResponse',
        'workspace-worker:recordSteer',
        'workspace-worker:settleSteer',
        'workspace-worker:enqueueFollowUp',
        'workspace-worker:cancelQueuedFollowUp',
        'workspace-worker:listQueuedFollowUps',
        'workspace-worker:listRequestResponses',
        'workspace-worker:listSteerIntents',
        'workspace-worker:promoteNextFollowUp',
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
