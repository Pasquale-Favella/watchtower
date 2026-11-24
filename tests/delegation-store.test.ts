import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Sqlite from '@effect/sql-sqlite-node'
import * as Effect from 'effect/Effect'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as SqlClient from 'effect/sql/SqlClient'
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
  limits: { maxDepth: 1 },
}

const withStore = async (use: (store: WorkspaceStore['Service']) => Promise<void>, filename = ':memory:') => {
  const runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename }))
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

  it('purges the Coach Task graph even when side chat and delegation rows exist', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-coach-graph-'))
    const filename = join(directory, 'workspace.sqlite')
    try {
      await withStore(async store => {
        await run(store.createDelegation(createCommand), store)
        await run(
          store.recordDriverEvent(parentRun.runId, {
            ownerEpoch: 7,
            generation: 1,
            eventId: 'graph-completed',
            occurredAt: ts,
            event: { kind: 'turnCompleted' },
          }),
          store,
        )
        const sideTask = { ...parentTask, id: 'side-task:legacy' as never }
        const sideConversation = { ...parentConversation, id: 'side-conversation:legacy' as never }
        await run(
          store.createTask({
            task: {
              ...sideTask,
              sideChat: { parentTaskId: parentTask.id, parentConversationId: parentConversation.id },
            },
            conversation: sideConversation,
          }),
          store,
        )
        const bringBack = {
          id: 'bring-back-legacy',
          parentTaskId: parentTask.id,
          parentConversationId: parentConversation.id,
          sideChatId: 'side-chat:legacy',
          sideTaskId: sideTask.id,
          sideConversationId: sideConversation.id,
          sourceRunId: 'side-run-legacy' as never,
          title: 'Side chat',
          digest: 'Assistant: A finding',
          truncated: false,
          status: 'pending' as const,
          createdAt: ts,
          consumedRunId: null,
          consumedAt: null,
        }
        await expect(run(store.recordSideChatBringBack(bringBack), store)).resolves.toMatchObject({ _tag: 'recorded' })
        // Normal Coach admission forbids both links. Mark the populated Project to exercise defensive deletion.
        await Effect.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`UPDATE workspace_project SET payload = json_set(payload, '$.isCoach', json('true')) WHERE id = ${project.id}`
          }).pipe(Effect.provide(Sqlite.SqliteClient.layer({ filename }))),
        )
        await expect(run(store.listDelegations({}), store)).resolves.toEqual({ items: [], truncated: false })
        await run(store.purgeCoachChat(parentTask.id), store)
        await expect(run(store.getDelegation(record.id), store)).resolves.toBeNull()
        await expect(run(store.readPendingSideChatBringBack(parentConversation.id), store)).resolves.toBeNull()
        for (const id of [parentTask.id, childTask.id, sideTask.id]) {
          await expect(run(store.readTaskDetail(id), store)).rejects.toMatchObject({ code: 'not-found' })
        }
      }, filename)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(['parent', 'child'] as const)('refuses to purge a Coach %s of a cross-project Delegation', async end => {
    const directory = mkdtempSync(join(tmpdir(), 'watchtower-coach-delegation-'))
    const filename = join(directory, 'workspace.sqlite')
    const otherProject = { ...project, id: 'p-other' as never, repositoryIdentity: 'repo:other' }
    const otherCheckout = { ...checkout, id: 'co-other' as never, path: 'C:/other' }
    const coachProjectId = end === 'parent' ? project.id : otherProject.id
    const coachTaskId = end === 'parent' ? parentTask.id : childTask.id
    try {
      await withStore(async store => {
        await run(store.registerProject({ project: otherProject, mainCheckout: otherCheckout }), store)
        await run(
          store.createDelegation({
            ...createCommand,
            task: { ...createCommand.task, projectId: otherProject.id },
            record: { ...record, projectId: otherProject.id, checkoutId: otherCheckout.id },
          }),
          store,
        )
        await run(
          store.recordDriverEvent(parentRun.runId, {
            ownerEpoch: 7,
            generation: 1,
            eventId: 'cross-project-parent-completed',
            occurredAt: ts,
            event: { kind: 'turnCompleted' },
          }),
          store,
        )
        await Effect.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient
            yield* sql`UPDATE workspace_project SET payload = json_set(payload, '$.isCoach', json('true')) WHERE id = ${coachProjectId}`
          }).pipe(Effect.provide(Sqlite.SqliteClient.layer({ filename }))),
        )
        await expect(run(store.purgeCoachChat(coachTaskId), store)).rejects.toMatchObject({
          code: 'membership-conflict',
        })
        await expect(run(store.sweepCoachChats(), store)).rejects.toMatchObject({ code: 'membership-conflict' })
        await expect(run(store.getDelegation(record.id), store)).resolves.toMatchObject({ id: record.id })
        for (const id of [parentTask.id, childTask.id]) {
          await expect(run(store.readTaskDetail(id), store)).resolves.toMatchObject({ task: { id } })
        }
      }, filename)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
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

  it('archives Delegated Tasks with their parent and keeps them out of every list', async () => {
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

      expect(await run(store.readTaskDetail(childTask.id), store)).toMatchObject({
        task: { status: 'archived', archivedAt: ts },
      })
      const visible = await run(store.listTasks(project.id), store)
      expect(visible.total).toBe(0)
      const withArchived = await run(store.listTasks(project.id, { includeArchived: true }), store)
      expect(withArchived.items.map(item => item.id)).toEqual([parentTask.id])

      await run(
        store.setTaskArchived({
          commandId: 'restore-parent',
          taskId: parentTask.id,
          archived: false,
          updatedAt: ts,
        }),
        store,
      )
      expect(await run(store.readTaskDetail(childTask.id), store)).toMatchObject({
        task: { status: 'open', archivedAt: null },
      })
      expect((await run(store.listTasks(project.id), store)).items.map(item => item.id)).toEqual([parentTask.id])
    })
  })

  it('refuses to archive a parent while a Delegated Task Run is active', async () => {
    await withStore(async store => {
      await run(store.createDelegation(createCommand), store)
      await run(
        store.beginRun({
          ...parentRun,
          commandId: 'child-start',
          runId: 'run-child' as never,
          taskId: childTask.id,
          conversationId: childConversation.id,
          provisionalAgentSessionId: 'child-session',
        }),
        store,
      )
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
      await expect(
        run(
          store.setTaskArchived({
            commandId: 'archive-busy-parent',
            taskId: parentTask.id,
            archived: true,
            updatedAt: ts,
          }),
          store,
        ),
      ).rejects.toMatchObject({ code: 'invalid-transition' })
      expect(await run(store.readTaskDetail(childTask.id), store)).toMatchObject({ task: { status: 'open' } })
    })
  })

  it('projects a claimed child as running in task detail before its driver starts', async () => {
    await withStore(async store => {
      await run(store.createDelegation(createCommand), store)
      const child = {
        ...parentRun,
        commandId: 'child-start',
        runId: record.childRunId!,
        taskId: childTask.id,
        conversationId: childConversation.id,
        provisionalAgentSessionId: 'child-session',
      }
      await run(store.beginRun(child), store)
      expect(await run(store.readTaskDetail(childTask.id), store)).toMatchObject({
        delegatedFrom: { delegationId: record.id, status: 'queued' },
      })
      await run(store.claimDispatch(child.runId, 7, ts), store)
      expect(await run(store.readTaskDetail(childTask.id), store)).toMatchObject({
        delegatedFrom: { delegationId: record.id, status: 'running' },
      })
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

  it('counts a wake delivery lost to an unclaimed promoted Run, so its re-enqueue is not a receipt replay', async () => {
    await withStore(async store => {
      await run(store.createDelegation(createCommand), store)
      await run(
        store.recordDriverEvent(parentRun.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'parent-completed',
          occurredAt: ts,
          event: { kind: 'turnCompleted' },
        }),
        store,
      )
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
      await run(
        store.setDelegationWake({
          commandId: 'wake-1',
          delegationId: 'dlg-1' as never,
          wakeState: 'pending',
          occurredAt: ts,
        }),
        store,
      )
      const wake = {
        commandId: 'delegation-wake:dlg-1',
        issuedAt: ts,
        taskId: parentTask.id,
        conversationId: parentConversation.id,
        prompt: 'The delegated task finished',
        origin: 'delegation' as const,
        delegationId: 'dlg-1' as never,
      }
      await run(store.enqueueFollowUp(wake), store)
      await run(
        store.promoteNextFollowUp(parentConversation.id, {
          ...parentRun,
          commandId: 'promote-wake',
          runId: 'run-wake' as never,
          provisionalAgentSessionId: 'session-wake',
        }),
        store,
      )
      // The Run was begun but the app exits before it is claimed; the next owners fail it.
      await run(store.acquireOwnerEpoch(ts), store)
      await run(store.acquireOwnerEpoch(ts), store)
      expect(
        (await run(store.readTaskSnapshot(parentTask.id, 20), store)).runs.find(r => r.id === 'run-wake'),
      ).toMatchObject({
        status: 'failed',
      })
      expect(await run(store.getDelegation('dlg-1'), store)).toMatchObject({ wakeState: 'pending', wakeAttempts: 1 })
      expect((await run(store.listDueDelegationWakes(10), store)).map(item => item.id)).toEqual(['dlg-1'])
      // The receipt of the promoted wake still answers its own id, but the next delivery has an id of its own.
      expect(await run(store.enqueueFollowUp(wake), store)).toMatchObject({ replayed: true })
      expect((await run(store.listQueuedFollowUps(parentConversation.id, { limit: 10 }), store)).items).toHaveLength(0)
      expect(
        await run(store.enqueueFollowUp({ ...wake, commandId: 'delegation-wake:dlg-1:retry-1' }), store),
      ).toMatchObject({
        replayed: false,
      })
      expect((await run(store.listQueuedFollowUps(parentConversation.id, { limit: 10 }), store)).items).toHaveLength(1)
    })
  })
})
