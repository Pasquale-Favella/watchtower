import { join } from 'node:path'

import * as Effect from 'effect/Effect'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Schema from 'effect/Schema'

import { delegationWakePrompt } from '@/core/domain/delegation/wake.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import { delegationIdSchema, type DelegationRecord, delegationRecordSchema } from '@/shared/schemas/delegation.js'
import type { AgentDriverEvent } from '@/shared/schemas/execution.js'
import { agentRunIdSchema } from '@/shared/schemas/workspace.js'
import {
  beginRunCommandSchema,
  createDelegationCommandSchema,
  createTaskCommandSchema,
  registerProjectCommandSchema,
  setDelegationWakeCommandSchema,
  settleDelegationCommandSchema,
} from '@/shared/schemas/workspace-store.js'

export const PARENT_TASK_TITLE = 'Coordinate the audit'
export const LIVE_TITLE = 'Audit the parser'
export const SETTLED_TITLE = 'Review the docs'
export const SETTLED_RESULT = 'No gaps found in the docs.'
export const WAKE_REPLY = 'Noted the docs review.'

const at = '2026-11-18T09:00:00Z'
const projectId = 'delegation-project'
const checkoutId = 'delegation-checkout'
const parentTaskId = 'delegation-parent'
const parentConversationId = 'delegation-parent-conversation'
const parentRunId = 'delegation-parent-run'
const liveDelegationId = 'dlg-live'
const liveTaskId = 'delegation-live-task'
const liveConversationId = 'delegation-live-conversation'
const liveRunId = 'delegation-live-run'
const settledDelegationId = 'dlg-settled'
const settledTaskId = 'delegation-settled-task'
const settledConversationId = 'delegation-settled-conversation'
const settledRunId = 'delegation-settled-run'
const wakeRunId = 'delegation-wake-run'

/**
 * A parent Task with two Delegated Tasks, written through the production store before Electron starts. The live child
 * was never claimed when the app reopens, so recovery settles it as failed with a wake. The settled child's wake was
 * already delivered, so the parent's wake Run shows a wake notice.
 */
export async function seedWorkspaceDelegation(profile: string, checkoutPath: string): Promise<void> {
  const runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename: join(profile, 'workspace.db') }))
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect)
  try {
    const store = await runtime.runPromise(WorkspaceStore)
    await run(
      store.registerProject(
        Schema.decodeUnknownSync(registerProjectCommandSchema)({
          project: {
            id: projectId,
            name: 'Delegation fixture',
            repositoryIdentity: 'fixture:delegation',
            createdAt: at,
            updatedAt: at,
          },
          mainCheckout: { id: checkoutId, kind: 'main', path: checkoutPath, createdAt: at },
        }),
      ),
    )
    await run(
      store.createTask(
        Schema.decodeUnknownSync(createTaskCommandSchema)({
          task: { id: parentTaskId, projectId, title: PARENT_TASK_TITLE, description: '', createdAt: at },
          conversation: { id: parentConversationId, title: PARENT_TASK_TITLE, createdAt: at },
        }),
      ),
    )

    const owner = await run(store.acquireOwnerEpoch(at))
    const parent = Schema.decodeUnknownSync(agentRunIdSchema)(parentRunId)
    await run(
      store.beginRun(
        Schema.decodeUnknownSync(beginRunCommandSchema)({
          commandId: 'delegation-parent-start',
          issuedAt: at,
          runId: parentRunId,
          taskId: parentTaskId,
          conversationId: parentConversationId,
          checkoutId,
          provisionalAgentSessionId: 'delegation-parent-session',
          generation: 1,
          driverId: 'fixture',
          connectionId: 'fixture',
          prompt: 'Split the audit between the parser and the docs.',
        }),
      ),
    )
    await run(store.claimDispatch(parent, owner.ownerEpoch, at))
    await run(
      store.acknowledgeDispatch(parent, {
        ownerEpoch: owner.ownerEpoch,
        nativeSessionId: 'delegation-parent-native',
        acknowledgedAt: at,
      }),
    )

    const childRecord = (input: {
      readonly id: string
      readonly title: string
      readonly taskId: string
      readonly conversationId: string
      readonly runId: string
    }): DelegationRecord =>
      Schema.decodeUnknownSync(delegationRecordSchema)({
      id: input.id,
      commandId: `delegation:${input.id}`,
      projectId,
      parentTaskId,
      parentConversationId,
      parentRunId,
      childTaskId: input.taskId,
      childConversationId: input.conversationId,
      childRunId: input.runId,
      checkoutId,
      depth: 1,
      title: input.title,
      driverId: 'fixture',
      connectionId: 'fixture',
      modelId: null,
      modeId: null,
      accessMode: 'approval-required',
      accessModeRequested: null,
      accessModeSteppedDownFrom: null,
      isolation: 'shared',
      status: 'queued',
      wake: 'always',
      wakeState: 'notDue',
      pendingRequest: null,
      resultText: null,
      resultTruncated: false,
      cancelRequestedAt: null,
      resultReadAt: null,
      createdAt: at,
      settledAt: null,
    })
    const createChild = (record: DelegationRecord) =>
      run(
        store.createDelegation(
          Schema.decodeUnknownSync(createDelegationCommandSchema)({
            commandId: `delegation:${record.id}`,
            issuedAt: at,
            parentRunId,
            parentTaskId,
            parentConversationId,
            task: { id: record.childTaskId, projectId, title: record.title, description: '', createdAt: at },
            conversation: { id: record.childConversationId, title: record.title, createdAt: at },
            record,
            limits: { maxDepth: 1, maxActivePerParentRun: 4 },
          }),
        ),
      )

    const live = childRecord({
      id: liveDelegationId,
      title: LIVE_TITLE,
      taskId: liveTaskId,
      conversationId: liveConversationId,
      runId: liveRunId,
    })
    await createChild(live)
    await run(
      store.beginRun(
        Schema.decodeUnknownSync(beginRunCommandSchema)({
          commandId: 'delegation-live-start',
          issuedAt: at,
          runId: liveRunId,
          taskId: liveTaskId,
          conversationId: liveConversationId,
          checkoutId,
          provisionalAgentSessionId: 'delegation-live-session',
          generation: 1,
          driverId: 'fixture',
          connectionId: 'fixture',
          prompt: 'Audit the parser for unchecked input.',
          origin: 'delegation',
          delegationId: liveDelegationId,
        }),
      ),
    )

    const settled = childRecord({
      id: settledDelegationId,
      title: SETTLED_TITLE,
      taskId: settledTaskId,
      conversationId: settledConversationId,
      runId: settledRunId,
    })
    await createChild(settled)
    await run(
      store.settleDelegation(
        Schema.decodeUnknownSync(settleDelegationCommandSchema)({
          commandId: 'delegation-settled-settle',
          delegationId: settledDelegationId,
          status: 'completed',
          resultText: SETTLED_RESULT,
          resultTruncated: false,
          occurredAt: at,
        }),
      ),
    )
    await run(
      store.setDelegationWake(
        Schema.decodeUnknownSync(setDelegationWakeCommandSchema)({
          commandId: 'delegation-settled-wake',
          delegationId: settledDelegationId,
          wakeState: 'delivered',
          occurredAt: at,
        }),
      ),
    )

    const parentEvent = (eventId: string, event: AgentDriverEvent) =>
      run(
        store.recordDriverEvent(parent, { ownerEpoch: owner.ownerEpoch, generation: 1, eventId, occurredAt: at, event }),
      )
    await parentEvent('parent-turn', { kind: 'turnStarted', nativeTurnId: 'delegation-turn' })
    await parentEvent('parent-start-tool', {
      kind: 'toolStarted',
      toolCallId: 'delegate-live',
      name: 'delegation_start',
      category: 'delegation',
      input: JSON.stringify({ task: 'Audit the parser for unchecked input.', title: LIVE_TITLE }),
    })
    await parentEvent('parent-start-result', {
      kind: 'toolCompleted',
      toolCallId: 'delegate-live',
      name: 'delegation_start',
      category: 'delegation',
      output: JSON.stringify({ id: liveDelegationId, childTaskId: liveTaskId, status: 'queued' }),
      orchestration: { delegationId: liveDelegationId, childTaskId: liveTaskId },
    })
    await parentEvent('parent-text', {
      kind: 'textDelta',
      text: 'Started the parser audit and kept the docs review going.',
    })
    await parentEvent('parent-complete', { kind: 'turnCompleted', nativeTurnId: 'delegation-turn' })

    // The wake Run starts once the parent is idle; its user message is the delegation wake the timeline shows as a notice.
    await run(
      store.beginRun(
        Schema.decodeUnknownSync(beginRunCommandSchema)({
          commandId: 'delegation-wake-start',
          issuedAt: at,
          runId: wakeRunId,
          taskId: parentTaskId,
          conversationId: parentConversationId,
          checkoutId,
          provisionalAgentSessionId: 'delegation-wake-session',
          generation: 1,
          driverId: 'fixture',
          connectionId: 'fixture',
          prompt: delegationWakePrompt({
            id: Schema.decodeUnknownSync(delegationIdSchema)(settledDelegationId),
            title: SETTLED_TITLE,
            status: 'completed',
            resultText: SETTLED_RESULT,
            resultTruncated: false,
          }),
          origin: 'delegation',
          delegationId: settledDelegationId,
        }),
      ),
    )
    const wake = Schema.decodeUnknownSync(agentRunIdSchema)(wakeRunId)
    await run(store.claimDispatch(wake, owner.ownerEpoch, at))
    await run(
      store.acknowledgeDispatch(wake, {
        ownerEpoch: owner.ownerEpoch,
        nativeSessionId: 'delegation-wake-native',
        acknowledgedAt: at,
      }),
    )
    await run(
      store.recordDriverEvent(wake, {
        ownerEpoch: owner.ownerEpoch,
        generation: 1,
        eventId: 'wake-reply',
        occurredAt: at,
        event: { kind: 'textDelta', text: WAKE_REPLY },
      }),
    )
    await run(
      store.recordDriverEvent(wake, {
        ownerEpoch: owner.ownerEpoch,
        generation: 1,
        eventId: 'wake-complete',
        occurredAt: at,
        event: { kind: 'turnCompleted' },
      }),
    )
  } finally {
    await runtime.dispose()
  }
}
