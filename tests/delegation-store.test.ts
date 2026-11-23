import * as Effect from 'effect/Effect'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { describe, expect, it } from 'vitest'

import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import type { DelegationRecord } from '@/shared/schemas/delegation.js'
import type { BeginRunCommand, CreateDelegationCommand } from '@/shared/schemas/workspace-store.js'

const ts = '2026-10-29T10:00:00Z'
const project = { id: 'p-1' as never, name: 'Project', repositoryIdentity: 'repo:one', createdAt: ts, updatedAt: ts }
const checkout = { id: 'co-1' as never, kind: 'main' as const, path: 'C:/repo', createdAt: ts }
const parentTask = { id: 't-parent' as never, projectId: project.id, title: 'Parent', description: '', createdAt: ts }
const parentConversation = { id: 'c-parent' as never, title: 'Parent chat', createdAt: ts }
const parentRun: BeginRunCommand = {
  commandId: 'cmd-parent',
  issuedAt: ts,
  runId: 'run-parent' as never,
  taskId: parentTask.id,
  conversationId: parentConversation.id,
  checkoutId: checkout.id,
  provisionalAgentSessionId: 'session-parent',
  generation: 1,
  driverId: 'claude-agent-sdk',
  connectionId: 'claude-1',
  prompt: 'Coordinate the audit',
}

const childTask = { id: 't-child' as never, title: 'Audit', description: '', createdAt: ts }
const childConversation = { id: 'c-child' as never, title: 'Audit', createdAt: ts }

const record: DelegationRecord = {
  id: 'dlg-1' as never,
  commandId: 'delegation:key-1',
  projectId: project.id,
  parentTaskId: parentTask.id,
  parentConversationId: parentConversation.id,
  parentRunId: parentRun.runId,
  childTaskId: childTask.id,
  childConversationId: childConversation.id,
  childRunId: 'run-child' as never,
  checkoutId: checkout.id,
  depth: 1,
  title: 'Audit',
  driverId: 'codex-app-server',
  connectionId: 'codex-1',
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
  createdAt: ts,
  settledAt: null,
}

const createCommand: CreateDelegationCommand = {
  commandId: 'delegation:key-1',
  issuedAt: ts,
  parentRunId: parentRun.runId,
  parentTaskId: parentTask.id,
  parentConversationId: parentConversation.id,
  task: { ...childTask, projectId: project.id, title: 'Audit' },
  conversation: childConversation,
  record,
  limits: { maxDepth: 1, maxActivePerParentRun: 4 },
}

const withStore = async (use: (store: WorkspaceStore['Service']) => Promise<void>) => {
  const runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename: ':memory:' }))
  try {
    const store = await runtime.runPromise(WorkspaceStore)
    await runtime.runPromise(store.registerProject({ project, mainCheckout: checkout }))
    await runtime.runPromise(store.createTask({ task: parentTask, conversation: parentConversation }))
    await runtime.runPromise(store.beginRun(parentRun))
    await runtime.runPromise(store.claimDispatch(parentRun.runId, 7, ts))
    await runtime.runPromise(
      store.acknowledgeDispatch(parentRun.runId, {
        ownerEpoch: 7,
        nativeSessionId: 'native-parent',
        acknowledgedAt: ts,
      }),
    )
    await use(store)
  } finally {
    await runtime.dispose()
  }
}

const run = <A, E>(effect: Effect.Effect<A, E, WorkspaceStore>, store: WorkspaceStore['Service']) =>
  Effect.runPromise(effect.pipe(Effect.provideService(WorkspaceStore, store)))

describe('delegation store', () => {
  it('creates the child Task and its Delegation together and replays by command id', async () => {
    await withStore(async store => {
      const first = await run(store.createDelegation(createCommand), store)
      expect(first).toMatchObject({ delegationId: 'dlg-1', replayed: false })
      const replay = await run(store.createDelegation(createCommand), store)
      expect(replay).toMatchObject({ delegationId: 'dlg-1', replayed: true })
      expect(await run(store.getDelegationByChildTask(childTask.id), store)).toMatchObject({ id: 'dlg-1', depth: 1 })
    })
  })

  it('refuses a child when the parent Run is not active', async () => {
    const runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename: ':memory:' }))
    try {
      const store = await runtime.runPromise(WorkspaceStore)
      await runtime.runPromise(store.registerProject({ project, mainCheckout: checkout }))
      await runtime.runPromise(store.createTask({ task: parentTask, conversation: parentConversation }))
      await runtime.runPromise(store.beginRun(parentRun))
      const refused = await runtime.runPromise(store.createDelegation(createCommand).pipe(Effect.flip))
      expect(refused.code).toBe('invalid-transition')
      expect(await runtime.runPromise(store.getDelegation('dlg-1'))).toBeNull()
    } finally {
      await runtime.dispose()
    }
  })

  it('keeps child Tasks out of the default list and shows the link on both sides', async () => {
    await withStore(async store => {
      await run(store.createDelegation(createCommand), store)
      const visible = await run(store.listTasks(project.id), store)
      expect(visible.items.map(item => item.id)).toEqual([parentTask.id])
      expect(visible.items[0]?.runtime?.delegatedChildren).toEqual({
        total: 1,
        active: 1,
        attention: 0,
        approvals: 0,
        questions: 0,
      })
      const withChildren = await run(store.listTasks(project.id, { includeDelegated: true }), store)
      const child = withChildren.items.find(item => item.id === childTask.id)
      expect(child?.runtime?.delegatedFrom).toMatchObject({ delegationId: 'dlg-1', parentTaskId: parentTask.id })
      const detail = await run(store.readTaskDetail(childTask.id), store)
      expect(detail.delegatedFrom).toMatchObject({ delegationId: 'dlg-1', parentTaskId: parentTask.id })
    })
  })

  it('lists a Delegated Task separately when its parent is archived', async () => {
    await withStore(async store => {
      await run(store.createDelegation(createCommand), store)
      await run(
        store.recordDriverEvent(parentRun.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'parent-interrupted',
          occurredAt: ts,
          event: { kind: 'turnInterrupted' },
        }),
        store,
      )
      await run(
        store.setTaskArchived({
          commandId: 'archive-parent',
          taskId: parentTask.id,
          archived: true,
          updatedAt: ts,
        }),
        store,
      )

      const visible = await run(store.listTasks(project.id), store)
      expect(visible.total).toBe(1)
      expect(visible.items.map(item => item.id)).toEqual([childTask.id])
      const withArchived = await run(store.listTasks(project.id, { includeArchived: true, limit: 1 }), store)
      expect(withArchived.total).toBe(2)
      expect(withArchived.items.map(item => item.id)).toEqual([childTask.id])
      expect(withArchived.nextAfterId).toBe(childTask.id)
      const next = await run(
        store.listTasks(project.id, {
          includeArchived: true,
          afterId: childTask.id,
          limit: 1,
        }),
        store,
      )
      expect(next.items.map(item => item.id)).toEqual([parentTask.id])
    })
  })

  it('counts pending approvals and questions only while their Delegation is unsettled', async () => {
    await withStore(async store => {
      await run(store.createDelegation(createCommand), store)
      async function setRequest(kind: 'approval' | 'question'): Promise<void> {
        await run(
          store.setDelegationPendingRequest({
            commandId: `pending-${kind}`,
            delegationId: record.id,
            pendingRequest: { requestId: kind, kind },
            occurredAt: ts,
          }),
          store,
        )
      }
      async function children() {
        return (await run(store.listTasks(project.id), store)).items[0]?.runtime.delegatedChildren
      }

      await setRequest('approval')
      expect(await children()).toEqual({ total: 1, active: 1, attention: 1, approvals: 1, questions: 0 })
      await setRequest('question')
      expect(await children()).toEqual({ total: 1, active: 1, attention: 1, approvals: 0, questions: 1 })
      await run(
        store.settleDelegation({
          commandId: 'settle-question',
          delegationId: record.id,
          status: 'completed',
          resultText: null,
          resultTruncated: false,
          occurredAt: ts,
        }),
        store,
      )
      expect(await children()).toEqual({ total: 1, active: 0, attention: 0, approvals: 0, questions: 0 })
    })
  })

  it('settles once, keeps the wake pending until the parent turn shows it, and marks read on demand', async () => {
    await withStore(async store => {
      await run(store.createDelegation(createCommand), store)
      await run(
        store.settleDelegation({
          commandId: 'settle-1',
          delegationId: 'dlg-1' as never,
          status: 'completed',
          resultText: 'Audit done',
          resultTruncated: false,
          occurredAt: ts,
        }),
        store,
      )
      const again = await run(
        store.settleDelegation({
          commandId: 'settle-2',
          delegationId: 'dlg-1' as never,
          status: 'failed',
          resultText: null,
          resultTruncated: false,
          occurredAt: ts,
        }),
        store,
      )
      expect(again).toMatchObject({ status: 'completed', resultText: 'Audit done' })
      await run(
        store.setDelegationWake({
          commandId: 'wake-1',
          delegationId: 'dlg-1' as never,
          wakeState: 'pending',
          occurredAt: ts,
        }),
        store,
      )
      expect((await run(store.listDueDelegationWakes(10), store)).map(item => item.id)).toEqual(['dlg-1'])
      const read = await run(store.markDelegationRead('dlg-1', ts), store)
      expect(read.resultReadAt).toBe(ts)
    })
  })

  it('stores a wake message with its origin and Delegated Task summary', async () => {
    await withStore(async store => {
      await run(store.createDelegation(createCommand), store)
      await run(
        store.beginRun({
          ...parentRun,
          commandId: 'cmd-child',
          runId: 'run-child' as never,
          taskId: childTask.id,
          conversationId: childConversation.id,
          checkoutId: checkout.id,
          provisionalAgentSessionId: 'session-child',
          driverId: 'codex-app-server',
          connectionId: 'codex-1',
          prompt: 'Audit the repository',
          origin: 'delegation',
          delegationId: 'dlg-1' as never,
        }),
        store,
      )
      const page = await run(store.readConversationPage(childConversation.id, 0, 20), store)
      const first = page.items[0]?.userMessage
      expect(first).toMatchObject({
        origin: 'delegation',
        delegation: { delegationId: 'dlg-1', childTaskId: childTask.id, title: 'Audit', status: 'queued' },
      })
    })
  })
})
