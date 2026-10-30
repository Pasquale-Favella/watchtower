import { describe, expect, it } from 'vitest'

import {
  conversationCatchupRequest,
  decodeConversationEvent,
  decodeConversationPayload,
  mergeConversationItems,
} from '../src/renderer/features/workspace/conversation-view.js'
import { nextConversationRequest } from '../src/renderer/features/workspace/lib.js'
import type { ConversationId } from '../src/shared/schemas/workspace.js'
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
  it('pages older tail history separately from fixed-watermark live catch-up', () => {
    const conversationId = 'conversation-1' as ConversationId
    const tailRequest = {
      conversationId,
      afterSequence: 0,
      direction: 'backward' as const,
      limit: 100,
    }
    const tailPage = {
      items: [],
      highWatermark: 300,
      nextAfterSequence: null,
      nextBeforeSequence: 200,
      hasMore: true,
    }
    const olderRequest = nextConversationRequest(tailRequest, tailPage)
    expect(olderRequest).toMatchObject({
      direction: 'backward',
      afterSequence: 0,
      beforeSequence: 200,
      throughSequence: 300,
    })

    const catchup = conversationCatchupRequest(conversationId, 300, 340, false, 100)
    expect(catchup).toMatchObject({ afterSequence: 300, throughSequence: 340 })
    expect(conversationCatchupRequest(conversationId, 300, 340, true, 100)).toBeNull()
    if (!catchup) throw new Error('Expected a live catch-up request')
    const catchupContinuation = nextConversationRequest(catchup, {
      items: [],
      highWatermark: 350,
      nextAfterSequence: 320,
      nextBeforeSequence: null,
      hasMore: true,
    })
    expect(catchupContinuation).toMatchObject({
      afterSequence: 320,
      throughSequence: 340,
    })
  })

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
    const fullEvent = event(8, { event: { kind: 'textDelta', text: 'Full assistant text', itemId: 'block-8' } })
    expect(
      decodeConversationPayload({ kind: 'message', id: 'message-1', digest: 'a'.repeat(64) }, JSON.stringify(message)),
    ).toEqual(message)
    expect(
      decodeConversationPayload({ kind: 'message', id: 'message-2', digest: 'a'.repeat(64) }, JSON.stringify(message)),
    ).toBeNull()
    expect(
      decodeConversationPayload({ kind: 'event', id: '8', digest: 'a'.repeat(64) }, JSON.stringify(message)),
    ).toBeNull()
    expect(
      decodeConversationPayload({ kind: 'event', id: '8', digest: 'a'.repeat(64) }, JSON.stringify(fullEvent)),
    ).toEqual(fullEvent)
    expect(
      decodeConversationPayload({ kind: 'event', id: '9', digest: 'a'.repeat(64) }, JSON.stringify(fullEvent)),
    ).toBeNull()
  })
})
