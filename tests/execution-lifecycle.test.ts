import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import {
  isAgentRunTerminal,
  makeRetryReference,
  transitionAgentRun,
  transitionTaskStatus,
} from '../src/core/domain/execution/lifecycle.js'
import { agentRunSchema } from '../src/shared/schemas/execution.js'
import { taskSchema } from '../src/shared/schemas/workspace.js'

describe('agent execution lifecycle policy', () => {
  const run = Schema.decodeUnknownSync(agentRunSchema)({
    id: 'run-1',
    taskId: 'task-1',
    attempt: 1,
    generation: 1,
    status: 'queued',
    submittedAt: '2026-10-29T10:00:00Z',
  })

  it('records a launch failure as a terminal attempt even before a native session exists', () => {
    const failed = transitionAgentRun(run, 'failed', '2026-10-29T10:00:01Z', { failure: 'launch failed' })
    expect(failed.ok).toBe(true)
    if (!failed.ok) return
    expect(failed.run).toMatchObject({ status: 'failed', finishedAt: '2026-10-29T10:00:01Z' })
    expect(failed.run).not.toHaveProperty('sessionId')
    expect(isAgentRunTerminal(failed.run.status)).toBe(true)
    expect(transitionAgentRun(failed.run, 'starting', '2026-10-29T10:00:02Z')).toEqual({
      ok: false,
      reason: 'terminal',
    })
  })

  it('allows requests to suspend a run and terminalizes only on a confirmed outcome', () => {
    const started = transitionAgentRun(run, 'starting', '2026-10-29T10:00:01Z')
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const running = transitionAgentRun(started.run, 'running', '2026-10-29T10:00:02Z')
    expect(running.ok).toBe(true)
    if (!running.ok) return
    const awaiting = transitionAgentRun(running.run, 'awaitingInput', '2026-10-29T10:00:03Z')
    expect(awaiting.ok).toBe(true)
    if (!awaiting.ok) return
    expect(isAgentRunTerminal(awaiting.run.status)).toBe(false)
    const complete = transitionAgentRun(awaiting.run, 'completed', '2026-10-29T10:00:04Z')
    expect(complete.ok && isAgentRunTerminal(complete.run.status)).toBe(true)
  })

  it('permits confirmed cancellation before native startup and retains an interruption request during launch', () => {
    const cancelled = transitionAgentRun(run, 'interrupted', '2026-10-29T10:00:01Z')
    expect(cancelled.ok && cancelled.run.finishedAt).toBe('2026-10-29T10:00:01Z')
    const starting = { ...run, status: 'starting' as const }
    const requested = transitionAgentRun(starting, 'interruptRequested', '2026-10-29T10:00:01Z')
    expect(requested.ok && requested.run.finishedAt).toBeUndefined()
    expect(requested.ok && isAgentRunTerminal(requested.run.status)).toBe(false)
  })

  it('sets the first execution timestamp when storage represents an unset timestamp as null', () => {
    const starting = { ...run, status: 'starting' as const, startedAt: null }
    const running = transitionAgentRun(starting, 'running', '2026-10-29T10:00:02Z')
    expect(running.ok && running.run.startedAt).toBe('2026-10-29T10:00:02Z')
    if (!running.ok) return
    const resumed = transitionAgentRun({ ...running.run, status: 'awaitingInput' }, 'running', '2026-10-29T10:00:05Z')
    expect(resumed.ok && resumed.run.startedAt).toBe('2026-10-29T10:00:02Z')
  })

  it('creates retry identity separately and allows task review independently of run completion', () => {
    expect(makeRetryReference(run)).toEqual({ retryOfRunId: 'run-1', attempt: 2 })
    expect(transitionTaskStatus('inProgress', 'inReview')).toEqual({ ok: true, status: 'inReview' })
    expect(transitionTaskStatus('completed', 'inProgress')).toEqual({ ok: false, reason: 'invalid-transition' })
    expect(
      Schema.decodeUnknownSync(taskSchema)({
        id: 'task-1',
        projectId: 'project-1',
        title: 'Task',
        description: '',
        status: 'inReview',
        createdAt: '2026-10-29T10:00:00Z',
        updatedAt: '2026-10-29T10:01:00Z',
      }).status,
    ).toBe('inReview')
  })
})
