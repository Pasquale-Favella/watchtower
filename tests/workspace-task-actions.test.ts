import * as Effect from 'effect/Effect'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { describe, expect, it } from 'vitest'

import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import type { BeginRunCommand } from '@/shared/schemas/workspace-store.js'

const at = '2026-11-16T10:00:00Z'

describe('Workspace Task actions', () => {
  it('renames, archives, restores, and refuses to archive a Task with an active Run', async () => {
    const runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename: ':memory:' }))
    try {
      const store = await runtime.runPromise(WorkspaceStore)
      const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect)
      await run(
        store.registerProject({
          project: {
            id: 'project-actions' as never,
            name: 'Actions',
            repositoryIdentity: 'repo:actions',
            createdAt: at,
            updatedAt: at,
          },
          mainCheckout: { id: 'checkout-actions' as never, kind: 'main', path: 'C:/actions', createdAt: at },
        }),
      )
      await run(
        store.createTask({
          task: {
            id: 'task-actions' as never,
            projectId: 'project-actions' as never,
            title: 'Original title',
            description: '',
            createdAt: at,
          },
          conversation: { id: 'conversation-actions' as never, createdAt: at },
        }),
      )

      const renamed = await run(
        store.renameTask({
          commandId: 'rename-actions',
          taskId: 'task-actions' as never,
          title: 'Renamed chat',
          updatedAt: at,
        }),
      )
      expect(renamed).toMatchObject({ taskId: 'task-actions', replayed: false })
      await expect(
        run(
          store.renameTask({
            commandId: 'rename-actions',
            taskId: 'task-actions' as never,
            title: 'Renamed chat',
            updatedAt: '2026-11-16T10:01:00Z',
          }),
        ),
      ).resolves.toMatchObject({ ...renamed, replayed: true })
      await expect(run(store.listTasks('project-actions' as never))).resolves.toMatchObject({
        items: [{ title: 'Renamed chat' }],
      })

      const archived = await run(
        store.setTaskArchived({
          commandId: 'archive-actions',
          taskId: 'task-actions' as never,
          archived: true,
          updatedAt: at,
        }),
      )
      expect(archived).toMatchObject({ taskId: 'task-actions', replayed: false })
      await expect(
        run(
          store.setTaskArchived({
            commandId: 'archive-actions',
            taskId: 'task-actions' as never,
            archived: true,
            updatedAt: '2026-11-16T10:01:00Z',
          }),
        ),
      ).resolves.toMatchObject({ ...archived, replayed: true })
      await expect(run(store.listTasks('project-actions' as never))).resolves.toMatchObject({ items: [], total: 0 })
      await expect(run(store.listTasks('project-actions' as never, { includeArchived: true }))).resolves.toMatchObject({
        items: [{ status: 'archived', archivedAt: at }],
      })
      await expect(run(store.readTaskDetail('task-actions' as never))).resolves.toMatchObject({
        task: { status: 'archived', archivedAt: at },
        conversations: [{ id: 'conversation-actions' }],
      })
      await expect(run(store.readTaskSnapshot('task-actions' as never, 10))).resolves.toMatchObject({
        task: { status: 'archived' },
      })
      await expect(run(store.listNativeAgentSessions('task-actions' as never))).resolves.toMatchObject({ items: [] })
      await expect(run(store.listPendingRuntimeRequests('task-actions' as never, 0, 10))).resolves.toMatchObject({
        items: [],
      })
      await run(
        store.setTaskArchived({
          commandId: 'restore-actions',
          taskId: 'task-actions' as never,
          archived: false,
          updatedAt: at,
        }),
      )
      await expect(run(store.listTasks('project-actions' as never))).resolves.toMatchObject({
        items: [{ status: 'open', archivedAt: null }],
      })

      const begin: BeginRunCommand = {
        commandId: 'run-actions',
        issuedAt: at,
        runId: 'run-actions' as never,
        taskId: 'task-actions' as never,
        conversationId: 'conversation-actions' as never,
        checkoutId: 'checkout-actions' as never,
        provisionalAgentSessionId: 'session-actions',
        generation: 1,
        driverId: 'codex',
        connectionId: 'connection-actions',
        prompt: 'Continue',
      }
      await run(store.beginRun(begin))
      await expect(
        run(
          store.setTaskArchived({
            commandId: 'archive-active-actions',
            taskId: 'task-actions' as never,
            archived: true,
            updatedAt: at,
          }),
        ),
      ).rejects.toMatchObject({ _tag: 'WorkspaceStoreError', code: 'invalid-transition' })
      await expect(run(store.listTasks('project-actions' as never))).resolves.toMatchObject({
        items: [{ status: 'open', archivedAt: null }],
      })

      await run(store.claimDispatch(begin.runId, 7, at))
      await run(
        store.failDispatch(begin.runId, {
          ownerEpoch: 7,
          occurredAt: at,
          outcome: 'uncertain',
          reason: 'event-stream-ended',
        }),
      )
      await expect(
        run(
          store.setTaskArchived({
            commandId: 'archive-unresolved',
            taskId: begin.taskId,
            archived: true,
            updatedAt: at,
          }),
        ),
      ).rejects.toMatchObject({ code: 'invalid-transition' })
      await run(store.releaseDispatchAfterCleanup(begin.runId, 7))
      await expect(
        run(
          store.setTaskArchived({ commandId: 'archive-resolved', taskId: begin.taskId, archived: true, updatedAt: at }),
        ),
      ).resolves.toMatchObject({ replayed: false })
      await run(
        store.setTaskArchived({ commandId: 'restore-resolved', taskId: begin.taskId, archived: false, updatedAt: at }),
      )

      const interrupted = {
        ...begin,
        commandId: 'run-interrupted',
        runId: 'run-interrupted' as never,
        provisionalAgentSessionId: 'session-interrupted',
      }
      await run(store.beginRun(interrupted))
      await run(store.claimDispatch(interrupted.runId, 7, at))
      await run(
        store.acknowledgeDispatch(interrupted.runId, {
          ownerEpoch: 7,
          nativeSessionId: 'native-interrupted',
          nativeTurnId: 'turn-interrupted',
          acknowledgedAt: at,
        }),
      )
      await run(
        store.recordDriverEvent(interrupted.runId, {
          ownerEpoch: 7,
          generation: 1,
          eventId: 'interrupted',
          occurredAt: at,
          event: { kind: 'turnInterrupted', nativeTurnId: 'turn-interrupted' },
        }),
      )
      await expect(
        run(
          store.setTaskArchived({
            commandId: 'archive-interrupted',
            taskId: begin.taskId,
            archived: true,
            updatedAt: at,
          }),
        ),
      ).resolves.toMatchObject({ replayed: false })
      await expect(run(store.readTaskDetail(begin.taskId))).resolves.toMatchObject({
        task: { status: 'archived' },
        conversations: [{ id: begin.conversationId }],
      })
      await expect(run(store.readTaskSnapshot(begin.taskId, 10))).resolves.toMatchObject({
        runs: expect.arrayContaining([expect.objectContaining({ id: interrupted.runId, status: 'interrupted' })]),
      })
      await expect(run(store.listNativeAgentSessions(begin.taskId))).resolves.toMatchObject({ total: 1 })
    } finally {
      await runtime.dispose()
    }
  })
})
