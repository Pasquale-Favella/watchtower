import { describe, expect, it } from 'vitest'

import { projectConversationView } from '@/renderer/features/workspace/conversation-view'
import type { AgentDriverEvent } from '@/shared/schemas/execution'
import type { WorkspaceConversationPageItem, WorkspaceExecutionEvent } from '@/shared/schemas/workspace-store'

function project(events: readonly AgentDriverEvent[]) {
  const items: WorkspaceConversationPageItem[] = events.map((event, index) => ({
    event: {
      sequence: index + 1,
      schemaVersion: 1,
      kind: 'driverEvent',
      runId: 'run-rich' as WorkspaceExecutionEvent['runId'],
      taskId: 'task-rich' as WorkspaceExecutionEvent['taskId'],
      generation: 1,
      occurredAt: new Date(Date.UTC(2026, 10, 3, 12, 0, index)).toISOString(),
      data: { event },
    },
  }))
  return projectConversationView(items).entries.flatMap(entry => (entry.kind === 'assistant' ? entry.blocks : []))
}

describe('rich conversation events', () => {
  it('keeps tool identity and metadata while appending independent input and output deltas', () => {
    const blocks = project([
      {
        kind: 'toolStarted',
        toolCallId: 'shell',
        name: 'Shell',
        category: 'command',
        command: 'npm test',
        input: '{',
        cwd: '/workspace',
      },
      { kind: 'toolUpdated', toolCallId: 'shell', input: '"command":"npm test"}', append: true },
      { kind: 'toolUpdated', toolCallId: 'shell', output: 'First\n', append: true },
      { kind: 'toolUpdated', toolCallId: 'shell', output: 'Second\n', append: true },
      { kind: 'toolCompleted', toolCallId: 'shell', exitCode: 1, durationMs: 42, error: 'Test failed' },
    ])
    expect(blocks).toEqual([
      expect.objectContaining({
        kind: 'tool',
        sequence: 1,
        name: 'Shell',
        category: 'command',
        command: 'npm test',
        cwd: '/workspace',
        input: '{"command":"npm test"}',
        output: 'First\nSecond\n',
        exitCode: 1,
        durationMs: 42,
        status: 'failed',
      }),
    ])
  })

  it('updates a plan in place across intervening messages and retains attachments in order', () => {
    const blocks = project([
      { kind: 'planUpdated', entries: [{ content: 'Inspect', status: 'inProgress' }] },
      { kind: 'textDelta', text: 'Inspecting.' },
      { kind: 'planUpdated', explanation: 'Done', entries: [{ content: 'Inspect', status: 'completed' }] },
      { kind: 'media', mediaType: 'image/png', url: 'data:image/png;base64,YWJj', alt: 'Result' },
    ])
    expect(blocks.map(block => block.kind)).toEqual(['plan', 'text', 'media'])
    expect(blocks[0]).toMatchObject({
      sequence: 1,
      explanation: 'Done',
      entries: [{ content: 'Inspect', status: 'completed' }],
    })
    expect(blocks[2]).toMatchObject({ sequence: 4, alt: 'Result' })
  })

  it('updates a repeated native image snapshot without duplicating or moving the row', () => {
    const blocks = project([
      {
        kind: 'media',
        itemId: 'tool:image:0',
        mediaType: 'image/png',
        url: 'data:image/png;base64,YWJj',
        alt: 'First',
      },
      { kind: 'textDelta', text: 'Result follows.' },
      {
        kind: 'media',
        itemId: 'tool:image:0',
        mediaType: 'image/png',
        url: 'data:image/png;base64,ZGVm',
        alt: 'Updated',
      },
    ])
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ kind: 'media', sequence: 1, alt: 'Updated', url: 'data:image/png;base64,ZGVm' })
  })
})
