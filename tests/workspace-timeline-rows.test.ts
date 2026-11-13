import { describe, expect, it } from 'vitest'

import { projectConversationView } from '../src/renderer/features/workspace/conversation-view.js'
import { buildTimelineRows } from '../src/renderer/features/workspace/timeline/timeline-rows.js'
import type { WorkspaceConversationPageItem, WorkspaceExecutionEvent } from '../src/shared/schemas/workspace-store.js'

function driverEvent(sequence: number, event: Record<string, unknown>): WorkspaceConversationPageItem {
  return {
    event: {
      sequence,
      schemaVersion: 1,
      kind: 'driverEvent',
      runId: 'run-1' as WorkspaceExecutionEvent['runId'],
      taskId: 'task-1' as WorkspaceExecutionEvent['taskId'],
      generation: 1,
      occurredAt: '2026-10-30T12:00:00.000Z',
      data: { event },
    },
  }
}

function delta(sequence: number, text: string, itemId = `item-${sequence}`): WorkspaceConversationPageItem {
  return driverEvent(sequence, { kind: 'textDelta', text, itemId })
}

function rows(items: WorkspaceConversationPageItem[]) {
  const projection = projectConversationView(items)
  return buildTimelineRows(projection.entries, projection.activity)
}

describe('virtual conversation rows', () => {
  it('virtualizes every block within a long Run rather than measuring the whole Run as one item', () => {
    const projected = rows(Array.from({ length: 350 }, (_, index) => delta(index + 1, `Message ${index}`)))
    expect(projected.filter(row => row.kind === 'segment')).toHaveLength(350)
    expect(projected.filter(row => row.kind === 'turnEnd')).toHaveLength(1)
    expect(projected.at(-1)?.kind).toBe('activity')
    expect(new Set(projected.map(row => row.id)).size).toBe(projected.length)
  })

  it('keeps loaded block keys when older pages extend the same assistant turn', () => {
    const recent = [delta(100, 'Recent'), delta(101, 'Latest')]
    const before = rows(recent).filter(row => row.kind === 'segment')
    const after = rows([delta(1, 'Oldest'), ...recent]).filter(row => row.kind === 'segment')
    expect(after.slice(1).map(row => row.id)).toEqual(before.map(row => row.id))
  })

  it('keeps a streaming row mounted when its text grows', () => {
    const first = delta(1, 'Partial', 'reply')
    const before = rows([first])
    const after = rows([first, delta(2, ' response', 'reply')])
    expect(after.map(row => row.id)).toEqual(before.map(row => row.id))
    expect(after[0]).toMatchObject({ segment: { block: { text: 'Partial response' } } })
  })

  it('keeps inspected activity rows mounted when the agent finishes, while untouched activity folds', () => {
    const started = driverEvent(1, { kind: 'toolStarted', toolCallId: 'shell', name: 'Bash' })
    const live = projectConversationView([started])
    const turn = live.entries.find(entry => entry.kind === 'assistant')
    if (!turn) throw new Error('Expected an assistant turn')
    const completed = projectConversationView([
      started,
      driverEvent(2, { kind: 'toolCompleted', toolCallId: 'shell' }),
      driverEvent(3, { kind: 'turnCompleted' }),
    ])
    const before = buildTimelineRows(live.entries, live.activity).filter(row => row.kind === 'segment')
    const inspected = buildTimelineRows(completed.entries, completed.activity, new Set([turn.id])).filter(
      row => row.kind === 'segment',
    )
    expect(inspected.map(row => row.id)).toEqual(before.map(row => row.id))
    expect(inspected[0]).toMatchObject({ segment: { kind: 'work', tools: [{ status: 'completed' }] } })
    expect(buildTimelineRows(completed.entries, completed.activity)[0]).toMatchObject({
      segment: { kind: 'fold' },
    })
  })
})
