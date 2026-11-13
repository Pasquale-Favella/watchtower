import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import {
  defaultWorkspaceNavigationState,
  mergeWorkspaceNavigation,
  readWorkspaceNavigation,
  type WorkspaceNavigationState,
  writeWorkspaceNavigation,
} from '@/renderer/features/workspace/workspace-navigation.js'
import { conversationIdSchema, projectIdSchema, taskIdSchema } from '@/shared/schemas/workspace.js'

function memoryStorage(initial?: string) {
  let value = initial ?? null
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next
    },
    value: () => value,
  }
}

describe('workspace navigation persistence', () => {
  it('round trips selected Project, Task, Conversation, and collapsed navigation', () => {
    const storage = memoryStorage()
    const state: WorkspaceNavigationState = {
      projectId: Schema.decodeUnknownSync(projectIdSchema)('project-1'),
      taskId: Schema.decodeUnknownSync(taskIdSchema)('task-2'),
      conversationId: Schema.decodeUnknownSync(conversationIdSchema)('conversation-3'),
      navigationCollapsed: true,
    }

    writeWorkspaceNavigation(storage, state)

    expect(readWorkspaceNavigation(storage)).toEqual(state)
  })

  it('uses a safe default for malformed or invalid persisted values', () => {
    expect(readWorkspaceNavigation(memoryStorage('{'))).toEqual(defaultWorkspaceNavigationState)
    expect(readWorkspaceNavigation(memoryStorage(JSON.stringify({ taskId: 'task-1' })))).toEqual(
      defaultWorkspaceNavigationState,
    )
    expect(readWorkspaceNavigation(null)).toEqual(defaultWorkspaceNavigationState)
  })

  it('merges a changed selection without discarding other preferences', () => {
    expect(
      mergeWorkspaceNavigation(
        {
          ...defaultWorkspaceNavigationState,
          projectId: Schema.decodeUnknownSync(projectIdSchema)('project-1'),
          navigationCollapsed: true,
        },
        { taskId: Schema.decodeUnknownSync(taskIdSchema)('task-2') },
      ),
    ).toEqual({
      projectId: 'project-1',
      taskId: 'task-2',
      conversationId: null,
      navigationCollapsed: true,
    })
  })
})
