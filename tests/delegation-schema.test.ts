import * as Result from 'effect/Result'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import { ApplicationRpcGroup } from '../src/shared/rpc/application.js'
import { WorkspaceDelegationRpcGroup } from '../src/shared/rpc/workspace-delegations.js'
import {
  DELEGATION_MAX_ACTIVE_PER_PARENT_RUN,
  DELEGATION_MAX_DEPTH,
  DELEGATION_WAIT_MAX_MS,
  delegationListSchema,
  delegationRecordSchema,
  delegationStartRequestSchema,
} from '../src/shared/schemas/delegation.js'
import { agentToolMetadataSchema } from '../src/shared/schemas/execution.js'
import {
  createDelegationCommandSchema,
  enqueueFollowUpCommandSchema,
  setDelegationWakeCommandSchema,
  workspaceConversationMessageSchema,
  workspaceTaskPageOptionsSchema,
  workspaceTaskRuntimeSummarySchema,
} from '../src/shared/schemas/workspace-store.js'

const ts = '2026-11-02T12:00:00.000Z'
const decodes = (schema: Schema.Decoder<unknown>, value: unknown) =>
  Result.isSuccess(Schema.decodeUnknownResult(schema)(value))

const record = {
  id: 'delegation-a',
  commandId: 'command-a',
  projectId: 'project',
  parentTaskId: 'parent-task',
  parentConversationId: 'parent-conversation',
  parentRunId: 'parent-run',
  childTaskId: 'child-task',
  childConversationId: 'child-conversation',
  childRunId: null,
  checkoutId: 'checkout',
  depth: 1,
  title: 'Investigate parser',
  driverId: 'claude',
  connectionId: 'claude-main',
  modelId: null,
  modeId: null,
  accessMode: 'approval-required',
  accessModeRequested: null,
  accessModeSteppedDownFrom: null,
  isolation: 'shared',
  status: 'queued',
  wake: 'settledOnly',
  wakeState: 'notDue',
  pendingRequest: null,
  resultText: null,
  resultTruncated: false,
  cancelRequestedAt: null,
  resultReadAt: null,
  createdAt: ts,
  settledAt: null,
}

describe('delegation contracts', () => {
  it('bounds start requests, wait timeouts and access modes', () => {
    expect(decodes(delegationStartRequestSchema, { prompt: 'Summarize the failing test.' })).toBe(true)
    expect(decodes(delegationStartRequestSchema, { prompt: 'x'.repeat(32 * 1024 + 1) })).toBe(false)
    expect(decodes(delegationStartRequestSchema, { prompt: 'run', waitTimeoutMs: DELEGATION_WAIT_MAX_MS })).toBe(true)
    expect(decodes(delegationStartRequestSchema, { prompt: 'run', waitTimeoutMs: DELEGATION_WAIT_MAX_MS + 1 })).toBe(
      false,
    )
    expect(decodes(delegationStartRequestSchema, { prompt: 'run', accessMode: 'read-only' })).toBe(false)
    expect(decodes(delegationStartRequestSchema, { prompt: 'run', isolation: 'worktree' })).toBe(true)
  })

  it('keeps a delegation at depth one with a closed status and a shared default', () => {
    expect(DELEGATION_MAX_DEPTH).toBe(1)
    expect(DELEGATION_MAX_ACTIVE_PER_PARENT_RUN).toBe(4)
    expect(decodes(delegationRecordSchema, record)).toBe(true)
    expect(decodes(delegationRecordSchema, { ...record, depth: 2 })).toBe(false)
    expect(decodes(delegationRecordSchema, { ...record, status: 'done' })).toBe(false)
    expect(decodes(delegationRecordSchema, { ...record, isolation: 'branch' })).toBe(false)
    expect(decodes(delegationListSchema, { items: [record], truncated: false })).toBe(true)
  })

  it('decodes existing workspace payloads without the additive delegation fields', () => {
    expect(
      decodes(workspaceTaskRuntimeSummarySchema, {
        runStatus: null,
        pendingRequestKind: null,
        latestRun: null,
      }),
    ).toBe(true)
    expect(decodes(workspaceConversationMessageSchema, { id: 'message-a', content: 'hello', createdAt: ts })).toBe(true)
    expect(decodes(workspaceTaskPageOptionsSchema, { limit: 10 })).toBe(true)
    expect(decodes(agentToolMetadataSchema, { category: 'subagent', command: 'ls' })).toBe(true)
  })

  it('carries delegation provenance, wake origin and orchestration references', () => {
    expect(
      decodes(workspaceTaskRuntimeSummarySchema, {
        runStatus: null,
        pendingRequestKind: null,
        latestRun: null,
        delegatedFrom: { delegationId: 'delegation-a', parentTaskId: 'parent-task', status: 'running' },
        delegatedChildren: { total: 2, active: 1, attention: 0 },
      }),
    ).toBe(true)
    expect(
      decodes(enqueueFollowUpCommandSchema, {
        commandId: 'wake-a',
        issuedAt: ts,
        taskId: 'parent-task',
        conversationId: 'parent-conversation',
        prompt: 'Delegated Task finished.',
        origin: 'delegation',
        delegationId: 'delegation-a',
      }),
    ).toBe(true)
    expect(
      decodes(agentToolMetadataSchema, {
        category: 'subagent',
        orchestration: { delegationId: 'delegation-a', childTaskId: 'child-task' },
      }),
    ).toBe(true)
    expect(decodes(workspaceTaskPageOptionsSchema, { includeDelegated: true })).toBe(true)
  })

  it('validates the store commands for delegation creation and wake state', () => {
    const command = {
      commandId: 'create-a',
      issuedAt: ts,
      parentRunId: 'parent-run',
      parentTaskId: 'parent-task',
      parentConversationId: 'parent-conversation',
      task: { id: 'child-task', projectId: 'project', title: 'Investigate parser', description: '', createdAt: ts },
      conversation: { id: 'child-conversation', createdAt: ts },
      record,
      limits: { maxDepth: DELEGATION_MAX_DEPTH, maxActivePerParentRun: DELEGATION_MAX_ACTIVE_PER_PARENT_RUN },
    }
    expect(decodes(createDelegationCommandSchema, command)).toBe(true)
    expect(
      decodes(createDelegationCommandSchema, { ...command, limits: { maxDepth: 0, maxActivePerParentRun: 4 } }),
    ).toBe(false)
    expect(
      decodes(setDelegationWakeCommandSchema, {
        commandId: 'wake-state-a',
        delegationId: 'delegation-a',
        wakeState: 'queued',
        occurredAt: ts,
      }),
    ).toBe(true)
  })

  it('registers the delegation group on the application RPC surface', () => {
    for (const method of ['delegation:list', 'delegation:get', 'delegation:cancel']) {
      expect(WorkspaceDelegationRpcGroup.requests.has(method)).toBe(true)
      expect(ApplicationRpcGroup.requests.has(method)).toBe(true)
    }
  })

})
