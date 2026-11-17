import { describe, expect, it } from 'vitest'

import {
  conversationCatchupRequest,
  decodeConversationEvent,
  decodeConversationPayload,
  mergeConversationItems,
  projectConversationView,
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

  it('marks the transcript when a queued run switches native agent sessions', () => {
    const firstMessage = { id: 'message-1', content: 'First prompt', createdAt: '2026-10-30T12:00:00Z' }
    const secondMessage = { id: 'message-2', content: 'Fresh prompt', createdAt: '2026-10-30T12:01:00Z' }
    const first = {
      ...item(1, firstMessage),
      event: { ...event(1), kind: 'runQueued' as const, runId: 'run-1' as WorkspaceExecutionEvent['runId'] },
    }
    const second = {
      ...item(2, secondMessage),
      event: { ...event(2), kind: 'runQueued' as const, runId: 'run-2' as WorkspaceExecutionEvent['runId'] },
    }

    const entries = projectConversationView(
      [first, second],
      new Map(),
      new Map([
        ['run-1', 'session-1'],
        ['run-2', 'session-2'],
      ]),
    ).entries

    expect(
      entries
        .filter(entry => entry.kind !== 'status' || entry.notice === 'newSession')
        .map(entry => (entry.kind === 'status' ? entry.notice : entry.kind)),
    ).toEqual(['user', 'newSession', 'user'])
  })

  it('shows prepared context handoffs and suppresses the duplicate generic session notice', () => {
    const sourceRunId = 'run-1' as WorkspaceExecutionEvent['runId']
    const targetRunId = 'run-2' as WorkspaceExecutionEvent['runId']
    const entries = projectConversationView(
      [
        {
          ...item(1),
          event: { ...event(1), kind: 'runQueued' as const, runId: sourceRunId },
        },
        {
          ...item(2),
          event: {
            ...event(2),
            kind: 'contextHandoff' as const,
            runId: targetRunId,
            data: {
              sourceRunId,
              sourceConnectionId: 'codex-local',
              sourceModelId: 'gpt-fast',
              targetConnectionId: 'claude-local',
              targetModelId: 'claude-sonnet',
              highWatermark: 17,
              truncated: true,
            },
          },
        },
        {
          ...item(3),
          event: { ...event(3), kind: 'runQueued' as const, runId: targetRunId },
        },
      ],
      new Map(),
      new Map([
        [sourceRunId, 'session-1'],
        [targetRunId, 'session-2'],
      ]),
    ).entries
    const notices = entries.filter(
      (entry): entry is Extract<typeof entry, { kind: 'status' }> => entry.kind === 'status',
    )
    expect(notices.map(entry => entry.notice)).toEqual([undefined, 'contextHandoff', undefined])
    expect(notices[1]?.handoff).toMatchObject({
      sourceConnectionId: 'codex-local',
      targetConnectionId: 'claude-local',
      sourceModelId: 'gpt-fast',
      targetModelId: 'claude-sonnet',
      highWatermark: 17,
      truncated: true,
    })
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

  it('hides only the legacy ACP session-info notice while preserving agent notices and errors', () => {
    const entries = projectConversationView([
      item(1),
      {
        ...item(2),
        event: event(2, {
          event: { kind: 'nativeNotice', message: 'ACP reported updated session information.' },
        }),
      },
      {
        ...item(3),
        event: event(3, { event: { kind: 'nativeNotice', message: 'The agent changed modes.' } }),
      },
      {
        ...item(4),
        event: event(4, { event: { kind: 'turnFailed', message: 'Agent failed.' } }),
      },
    ]).entries
    const assistant = entries.find(entry => entry.kind === 'assistant')
    if (!assistant || assistant.kind !== 'assistant') throw new Error('Expected an assistant turn')

    expect(assistant.blocks.filter(block => block.kind === 'notice').map(block => block.event)).toEqual([
      { kind: 'nativeNotice', message: 'The agent changed modes.' },
      { kind: 'turnFailed', message: 'Agent failed.' },
    ])
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
