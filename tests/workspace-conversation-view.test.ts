import { describe, expect, it } from 'vitest'

import {
  decodeConversationEvent,
  decodeConversationPayload,
  mergeConversationItems,
} from '../src/renderer/features/workspace/conversation-view.js'
import type { WorkspaceConversationPageItem, WorkspaceExecutionEvent } from '../src/shared/schemas/workspace-store.js'

const event = (sequence: number, data: Record<string, unknown> = {}): WorkspaceExecutionEvent => ({
  sequence,
  schemaVersion: 1,
  kind: 'driverEvent',
  runId: 'run-1' as WorkspaceExecutionEvent['runId'],
  taskId: 'task-1' as WorkspaceExecutionEvent['taskId'],
  generation: 1,
  occurredAt: '2026-10-30T12:00:00Z',
  data,
})

const item = (
  sequence: number,
  userMessage?: WorkspaceConversationPageItem['userMessage'],
): WorkspaceConversationPageItem => ({
  event: event(sequence),
  ...(userMessage ? { userMessage } : {}),
})

describe('conversation durable view projection', () => {
  it('merges pages in sequence order and keeps one copy of overlap', () => {
    const first = [item(1), item(2)]
    const merged = mergeConversationItems(first, [item(2), item(3)])
    expect(merged.map(row => row.event.sequence)).toEqual([1, 2, 3])
  })

  it('preserves a user message attached to a duplicated run event', () => {
    const message = { id: 'message-1', content: 'Original prompt', createdAt: '2026-10-30T12:00:00Z' }
    expect(mergeConversationItems([item(1, message)], [item(1)])[0]?.userMessage).toEqual(message)
  })

  it('decodes only valid driver events and ignores summarized payload bodies', () => {
    expect(decodeConversationEvent(event(1, { event: { kind: 'textDelta', text: 'full text' } }))).toEqual({
      kind: 'textDelta',
      text: 'full text',
    })
    expect(
      decodeConversationEvent({
        ...event(2, { event: { kind: 'textDelta', text: 'preview' } }),
        payloadTruncated: true,
      }),
    ).toBeNull()
    expect(decodeConversationEvent(event(3, { event: { kind: 'unknown' } }))).toBeNull()
  })

  it('validates payload type and record identity after chunk reassembly', () => {
    const message = { id: 'message-1', content: 'Full prompt', createdAt: '2026-10-30T12:00:00Z' }
    expect(
      decodeConversationPayload({ kind: 'message', id: 'message-1', digest: 'a'.repeat(64) }, JSON.stringify(message)),
    ).toEqual(message)
    expect(
      decodeConversationPayload({ kind: 'message', id: 'message-2', digest: 'a'.repeat(64) }, JSON.stringify(message)),
    ).toBeNull()
    expect(
      decodeConversationPayload({ kind: 'event', id: '8', digest: 'a'.repeat(64) }, JSON.stringify(message)),
    ).toBeNull()
  })
})
