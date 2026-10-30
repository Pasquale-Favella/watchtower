import { describe, expect, it } from 'vitest'

import {
  nextConversationRequest,
  nextPayloadRequest,
  type WorkspaceRequest,
} from '../src/renderer/features/workspace/lib.js'

const conversation = {
  conversationId: 'conversation-1',
  afterSequence: 0,
  limit: 50,
} as WorkspaceRequest<'workspace:readConversationPage'>

describe('workspace page cursors', () => {
  it('pins all forward pages to the original watermark and hands off at that watermark', () => {
    const next = nextConversationRequest(conversation, {
      items: [],
      highWatermark: 42,
      hasMore: true,
      nextAfterSequence: 12,
    })
    expect(next).toEqual({ conversationId: 'conversation-1', afterSequence: 12, limit: 50, throughSequence: 42 })
    if (!next) throw new Error('Expected another page')
    expect(
      nextConversationRequest(next, { items: [], highWatermark: 42, hasMore: false, nextAfterSequence: null }),
    ).toBeNull()
  })

  it('preserves a caller-supplied bound instead of advancing into live events', () => {
    expect(
      nextConversationRequest(
        { ...conversation, throughSequence: 30 },
        { items: [], highWatermark: 30, hasMore: true, nextAfterSequence: 20 },
      )?.throughSequence,
    ).toBe(30)
  })

  it('pages backward from the tail with a fixed watermark and non-overlapping before cursor', () => {
    const tailRequest = { ...conversation, direction: 'backward' as const }
    const older = nextConversationRequest(tailRequest, {
      items: [],
      highWatermark: 900,
      hasMore: true,
      nextAfterSequence: null,
      nextBeforeSequence: 400,
    })
    expect(older).toEqual({
      ...tailRequest,
      afterSequence: 0,
      throughSequence: 900,
      beforeSequence: 400,
    })
    expect(
      nextConversationRequest(older!, {
        items: [],
        highWatermark: 900,
        hasMore: false,
        nextAfterSequence: null,
        nextBeforeSequence: null,
      }),
    ).toBeNull()
  })

  it('retrieves summarized JSON by offset without replacing its digest-pinned reference', () => {
    const request: WorkspaceRequest<'workspace:readWorkspacePayload'> = {
      reference: { kind: 'event', id: '1', digest: 'a'.repeat(64) },
      afterOffset: 0,
      limit: 4096,
    }
    expect(nextPayloadRequest(request, { json: 'first', total: 10, nextAfterOffset: 5, truncated: true })).toEqual({
      ...request,
      afterOffset: 5,
    })
    expect(nextPayloadRequest(request, { json: 'last', total: 10, nextAfterOffset: null, truncated: false })).toBeNull()
  })
})
