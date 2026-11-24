import { describe, expect, it } from 'vitest'

import { mergeConversationItems, projectConversation } from '../src/renderer/features/workspace/conversation-view.js'
import type { WorkspaceConversationPageItem, WorkspaceExecutionEvent } from '../src/shared/schemas/workspace-store.js'

const event = (
  sequence: number,
  runId: string,
  driver: Record<string, unknown>,
  generation = 1,
): WorkspaceExecutionEvent => ({
  sequence,
  schemaVersion: 1,
  kind: 'driverEvent',
  runId: runId as WorkspaceExecutionEvent['runId'],
  taskId: 'task-1' as WorkspaceExecutionEvent['taskId'],
  generation,
  occurredAt: `2026-10-30T12:00:${String(sequence).padStart(2, '0')}Z`,
  data: { event: driver },
})

const item = (sequence: number, runId: string, driver: Record<string, unknown>): WorkspaceConversationPageItem => ({
  event: event(sequence, runId, driver),
})

describe('durable conversation turn projection', () => {
  it('groups adjacent text by native item identity, while preserving intervening blocks and run order', () => {
    const entries = projectConversation([
      item(1, 'run-a', { kind: 'turnStarted', nativeTurnId: 'native-a' }),
      item(2, 'run-a', { kind: 'textDelta', text: 'first ', itemId: 'answer' }),
      item(3, 'run-a', { kind: 'textDelta', text: 'part', itemId: 'answer' }),
      item(4, 'run-b', { kind: 'textDelta', text: 'parallel answer', itemId: 'response' }),
      item(5, 'run-a', { kind: 'reasoningDelta', text: 'thinking', itemId: 'reasoning-a' }),
      item(6, 'run-a', { kind: 'textDelta', text: 'second block', itemId: 'answer' }),
    ])

    expect(
      entries.map(entry => (entry.kind === 'assistant' ? [entry.runId, entry.sequence] : [entry.id, entry.sequence])),
    ).toEqual([
      ['run-a', 1],
      ['run-b', 4],
      ['run-a', 5],
    ])
    const turnA = entries[0]
    expect(turnA?.kind).toBe('assistant')
    if (turnA?.kind !== 'assistant') return
    expect(turnA.nativeTurnId).toBe('native-a')
    const partial = projectConversation([
      item(1, 'run-a', { kind: 'turnStarted', nativeTurnId: 'native-a' }),
      item(2, 'run-a', { kind: 'textDelta', text: 'first ', itemId: 'answer' }),
    ])
    expect(turnA.id).toBe(partial.find(entry => entry.kind === 'assistant')?.id)
    expect(turnA.blocks.map(block => block.kind)).toEqual(['text'])
    expect(turnA.blocks[0]).toMatchObject({ kind: 'text', text: 'first part', itemId: 'answer', sequence: 2 })
    const continuation = entries[2]
    expect(continuation?.kind).toBe('assistant')
    if (continuation?.kind !== 'assistant') return
    expect(continuation.blocks.map(block => block.kind)).toEqual(['thinking', 'text'])
    expect(continuation.blocks[1]).toMatchObject({ kind: 'text', text: 'second block', sequence: 6 })
  })

  it('groups tool lifecycle by invocation, keeps the visible order, and retains error provenance', () => {
    const entries = projectConversation([
      item(1, 'run-a', { kind: 'textDelta', text: 'Before tool.' }),
      item(2, 'run-a', { kind: 'toolStarted', toolCallId: 'tool-1', name: 'read_file', input: 'src/a.ts' }),
      item(3, 'run-a', { kind: 'toolStarted', toolCallId: 'tool-2', name: 'search', input: 'query' }),
      item(4, 'run-a', { kind: 'toolUpdated', toolCallId: 'tool-1', output: 'partial output' }),
      item(5, 'run-a', { kind: 'textDelta', text: 'After tool.' }),
      item(6, 'run-a', { kind: 'toolCompleted', toolCallId: 'tool-2' }),
      item(7, 'run-a', { kind: 'toolCompleted', toolCallId: 'tool-1', error: 'permission denied' }),
    ])
    const turn = entries[0]
    expect(turn?.kind).toBe('assistant')
    if (turn?.kind !== 'assistant') return
    expect(turn.blocks.map(block => block.kind)).toEqual(['text', 'tool', 'tool', 'text'])
    expect(turn.blocks[1]).toMatchObject({
      kind: 'tool',
      toolCallId: 'tool-1',
      name: 'read_file',
      input: 'src/a.ts',
      output: 'partial output',
      error: 'permission denied',
      status: 'failed',
      sequence: 2,
    })
    expect(turn.blocks[2]).toMatchObject({
      kind: 'tool',
      toolCallId: 'tool-2',
      name: 'search',
      status: 'completed',
      sequence: 3,
    })
    expect(turn.audit.map(row => row.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('keeps a tool completion error when the start record is unavailable', () => {
    const entries = projectConversation([
      item(2, 'run-a', { kind: 'toolCompleted', toolCallId: 'tool-missing', error: 'native failure' }),
    ])
    const turn = entries[0]
    expect(turn?.kind === 'assistant' && turn.blocks[0]).toMatchObject({
      kind: 'tool',
      toolCallId: 'tool-missing',
      error: 'native failure',
      status: 'failed',
    })
  })

  it('carries known tool provenance through an interleaved Run segment', () => {
    const entries = projectConversation([
      item(1, 'run-a', { kind: 'toolStarted', toolCallId: 'tool-1', name: 'read_file', input: 'src/a.ts' }),
      item(2, 'run-b', { kind: 'textDelta', text: 'Other Run output' }),
      item(3, 'run-a', { kind: 'toolUpdated', toolCallId: 'tool-1', output: 'file contents' }),
      item(4, 'run-a', { kind: 'toolCompleted', toolCallId: 'tool-1' }),
    ])

    expect(entries.map(entry => (entry.kind === 'assistant' ? [entry.runId, entry.sequence] : entry.kind))).toEqual([
      ['run-a', 1],
      ['run-b', 2],
      ['run-a', 3],
    ])
    const continuation = entries[2]
    expect(continuation?.kind).toBe('assistant')
    if (continuation?.kind !== 'assistant') return
    expect(continuation.blocks[0]).toMatchObject({
      kind: 'tool',
      toolCallId: 'tool-1',
      name: 'read_file',
      input: 'src/a.ts',
      output: 'file contents',
      status: 'completed',
      continued: true,
      sequence: 3,
    })
  })

  it('keeps truncated assistant content at its event position, then hydrates that same block identity', () => {
    const promptStart = item(1, 'run-a', { kind: 'turnStarted' })
    const full = event(2, 'run-a', { kind: 'textDelta', text: 'Recovered ', itemId: 'answer' })
    const truncated: WorkspaceExecutionEvent = {
      ...full,
      data: {},
      payloadTruncated: true,
      payloadRef: { kind: 'event', id: '2', digest: 'b'.repeat(64) },
    }
    const following = item(3, 'run-a', { kind: 'textDelta', text: 'answer', itemId: 'answer' })
    const beforeHydration = projectConversation([promptStart, { event: truncated }, following])
    const hydrated = projectConversation([promptStart, { event: truncated }, following], new Map([[2, full]]))

    expect(beforeHydration).toHaveLength(1)
    expect(hydrated).toHaveLength(1)
    expect(beforeHydration[0]?.kind).toBe('assistant')
    expect(hydrated[0]?.kind).toBe('assistant')
    if (beforeHydration[0]?.kind !== 'assistant' || hydrated[0]?.kind !== 'assistant') return
    expect(hydrated[0].id).toBe(beforeHydration[0].id)
    expect(beforeHydration[0].blocks[0]).toMatchObject({ kind: 'unavailable', sequence: 2 })
    expect(hydrated[0].blocks).toEqual([{ kind: 'text', text: 'Recovered answer', itemId: 'answer', sequence: 2 }])
    expect(hydrated[0].audit.map(row => row.sequence)).toEqual([1, 2, 3])
  })

  it('surfaces failed and uncertain Run lifecycle records in chronological status entries', () => {
    const entries = projectConversation([
      {
        event: {
          ...event(1, 'run-a', {}),
          kind: 'dispatchClaimed',
          data: { launchState: 'starting' },
        } as WorkspaceConversationPageItem['event'],
      },
      {
        event: {
          ...event(2, 'run-a', {}),
          kind: 'runFailed',
          data: { reason: 'launch rejected' },
        } as WorkspaceConversationPageItem['event'],
      },
      {
        event: {
          ...event(3, 'run-b', {}),
          kind: 'runUncertain',
          data: { reason: 'acknowledgement lost' },
        } as WorkspaceConversationPageItem['event'],
      },
    ])

    expect(entries.map(entry => entry.kind)).toEqual(['status', 'status', 'status'])
    expect(entries.map(entry => entry.kind === 'status' && [entry.sequence, entry.event.kind])).toEqual([
      [1, 'dispatchClaimed'],
      [2, 'runFailed'],
      [3, 'runUncertain'],
    ])
  })

  it('deduplicates overlapping replay pages and associates each user message once', () => {
    const prompt = { id: 'message-1', content: 'Inspect this', createdAt: '2026-10-30T12:00:00Z' }
    const first = [{ ...item(1, 'run-a', { kind: 'turnStarted' }), userMessage: prompt }]
    const overlap = [item(1, 'run-a', { kind: 'turnStarted' }), item(2, 'run-a', { kind: 'textDelta', text: 'Done' })]
    const merged = mergeConversationItems(first, overlap)
    const entries = projectConversation(mergeConversationItems(merged, overlap))

    expect(entries.map(entry => entry.kind)).toEqual(['user', 'assistant'])
    expect(entries.filter(entry => entry.kind === 'user')).toHaveLength(1)
    const turn = entries[1]
    expect(turn?.kind === 'assistant' && turn.audit.map(row => row.sequence)).toEqual([1, 2])
  })

  it('keeps generations and native turns distinct and does not infer completion at end of available history', () => {
    const entries = projectConversation([
      item(1, 'run-a', { kind: 'textDelta', text: 'first attempt' }),
      { event: event(2, 'run-a', { kind: 'textDelta', text: 'new generation' }, 2) },
      item(3, 'run-a', { kind: 'turnStarted', nativeTurnId: 'native-2' }),
      item(4, 'run-a', { kind: 'textDelta', text: 'same native turn' }),
    ])

    expect(entries).toHaveLength(3)
    expect(
      entries
        .filter(entry => entry.kind === 'assistant')
        .map(entry => entry.kind === 'assistant' && [entry.generation, entry.nativeTurnId]),
    ).toEqual([
      [1, null],
      [2, null],
      [1, 'native-2'],
    ])
    expect(entries.every(entry => entry.kind !== 'assistant' || !('status' in entry))).toBe(true)
    expect(entries[1]?.kind === 'assistant' && entries[1].blocks).toEqual([
      { kind: 'text', text: 'new generation', itemId: null, sequence: 2 },
    ])
  })
})
