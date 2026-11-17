import { describe, expect, it } from 'vitest'

import type { AgentRun } from '../src/shared/schemas/execution.js'
import { sideChatStatus, sideChatStatusLabel } from '../src/renderer/features/workspace/side-chat/status.js'

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
