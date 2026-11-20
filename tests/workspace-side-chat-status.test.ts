import { describe, expect, it } from 'vitest'

import {
  sideChatCommandBlock,
  sideChatStatus,
  sideChatStatusLabel,
  sideChatTabState,
} from '../src/renderer/features/workspace/side-chat/status.js'
import type { AgentRun } from '../src/shared/schemas/execution.js'

function run(id: string, status: AgentRun['status'], submittedAt: string): AgentRun {
  return {
    id: id as AgentRun['id'],
    taskId: 'side-task:test' as AgentRun['taskId'],
    attempt: 1,
    generation: 1,
    status,
    submittedAt,
    startedAt: null,
    finishedAt: null,
  }
}

describe('side chat relationship status', () => {
  it('shows no-run side chats as not started', () => {
    expect(sideChatStatus([])).toBe('notStarted')
  })

  it.each([
    ['queued', 'queued', 'Queued'],
    ['starting', 'running', 'Running'],
    ['running', 'running', 'Running'],
    ['awaitingInput', 'waiting', 'Waiting'],
    ['interruptRequested', 'stopping', 'Stopping'],
    ['completed', 'completed', 'Completed'],
    ['interrupted', 'stopped', 'Stopped'],
    ['failed', 'failed', 'Failed'],
    ['uncertain', 'needsAttention', 'Needs attention'],
    ['recoveryRequired', 'recovering', 'Recovering'],
  ] as const)('maps %s to a visible status', (input, expected, label) => {
    expect(sideChatStatus([run('run-1', input, '2026-11-01T12:00:00Z')])).toBe(expected)
    expect(sideChatStatusLabel(expected)).toBe(label)
  })

  it('prefers a newer active attempt over an older completed one', () => {
    expect(
      sideChatStatus([
        run('run-1', 'completed', '2026-11-01T12:00:00Z'),
        run('run-2', 'running', '2026-11-02T12:00:00Z'),
      ]),
    ).toBe('running')
  })
})

describe('side chat tab state', () => {
  const running = [run('run-1', 'running', '2026-11-02T12:00:00Z')]
  const finished = [run('run-1', 'completed', '2026-11-02T12:00:00Z')]

  it.each([
    ['approval', null, 'needsApproval'],
    ['question', null, 'needsInput'],
    [null, 'awaitingInput', 'needsInput'],
    [null, 'running', 'running'],
    [null, 'completed', null],
  ] as const)('maps pending request %s with run status %s to %s', (pendingRequestKind, status, expected) => {
    const runs = status === null ? [] : [run('run-1', status, '2026-11-02T12:00:00Z')]
    expect(sideChatTabState({ runs, pendingRequestKind })).toBe(expected)
  })

  it('shows an approval over a running Run, and no dot for a finished side chat', () => {
    expect(sideChatTabState({ runs: running, pendingRequestKind: 'approval' })).toBe('needsApproval')
    expect(sideChatTabState({ runs: finished, pendingRequestKind: undefined })).toBeNull()
  })
})

describe('side chat command block', () => {
  it('blocks a side chat inside a side chat, whatever the draft holds', () => {
    expect(sideChatCommandBlock({ embedded: true, attachmentCount: 0 })).toEqual({
      reason: 'Side chats cannot start side chats.',
    })
  })

  it('refuses attachments and context on a side chat start, and allows plain text', () => {
    expect(sideChatCommandBlock({ embedded: false, attachmentCount: 2 })?.reason).toContain('take text only')
    expect(sideChatCommandBlock({ embedded: false, attachmentCount: 0 })).toBeNull()
  })
})
