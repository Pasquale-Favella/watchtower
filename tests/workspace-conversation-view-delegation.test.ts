import { describe, expect, it } from 'vitest'

import { projectConversationView } from '@/renderer/features/workspace/conversation-view.js'
import type { WorkspaceConversationPageItem } from '@/shared/schemas/workspace-store.js'

describe('delegated task prompts', () => {
  it('shows the first task prompt as a user message in the child conversation', () => {
    const item: WorkspaceConversationPageItem = {
      event: {
        sequence: 1,
        schemaVersion: 1,
        kind: 'runQueued',
        runId: 'run-child' as never,
        taskId: 'task-child' as never,
        generation: 1,
        occurredAt: '2026-10-30T12:00:00Z',
        data: {},
      },
      userMessage: {
        id: 'user:run-child',
        content: 'Check the migration',
        createdAt: '2026-10-30T12:00:00Z',
        origin: 'delegation',
        delegation: {
          delegationId: 'delegation-1' as never,
          childTaskId: 'task-child' as never,
          title: 'Migration',
          status: 'completed',
        },
      },
    }

    const { entries } = projectConversationView([item])

    expect(entries.filter(entry => entry.kind !== 'status' || entry.notice)).toMatchObject([
      { kind: 'user', message: { content: 'Check the migration' } },
    ])
  })
})
