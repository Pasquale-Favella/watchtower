import * as ManagedRuntime from 'effect/ManagedRuntime'
import { expect, it } from 'vitest'

import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import { conversationIdSchema, projectIdSchema, taskIdSchema, workspaceCheckoutIdSchema } from '@/shared/schemas/workspace.js'

it('searches older Conversation identities in the worker, independently of loaded Task pages', async () => {
  const runtime = ManagedRuntime.make(WorkspaceStoreLive({ filename: ':memory:' }))
  try {
    const store = await runtime.runPromise(WorkspaceStore)
    const projectId = projectIdSchema.make('project')
    const createdAt = '2026-11-09T12:00:00Z'
    await runtime.runPromise(store.registerProject({
      project: { id: projectId, name: 'Project', repositoryIdentity: 'repo:prompt-test', createdAt, updatedAt: createdAt },
      mainCheckout: { id: workspaceCheckoutIdSchema.make('checkout'), kind: 'main', path: 'C:/fixture', createdAt },
    }))
    for (let index = 0; index < 55; index++) {
      await runtime.runPromise(store.createTask({
        task: { id: taskIdSchema.make(`task-${index}`), projectId, title: `Task ${index}`, description: '', createdAt },
        conversation: { id: conversationIdSchema.make(`conversation-${index}`), title: index === 54 ? 'Older matching discussion' : `Discussion ${index}`, createdAt },
      }))
    }
    const search = store.searchPromptConversations
    if (!search) throw new Error('Conversation search was not installed')
    expect(await runtime.runPromise(search({ query: 'older' }))).toEqual([
      { taskId: 'task-54', conversationId: 'conversation-54', title: 'Older matching discussion' },
    ])
    expect(await runtime.runPromise(search({ query: 'older', excludeConversationId: conversationIdSchema.make('conversation-54') }))).toEqual([])
    expect(await runtime.runPromise(search({ query: '' }))).toHaveLength(8)
  } finally {
    await runtime.dispose()
  }
})
