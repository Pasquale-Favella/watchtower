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
    } finally {
      await runtime.dispose()
    }
  })
})
