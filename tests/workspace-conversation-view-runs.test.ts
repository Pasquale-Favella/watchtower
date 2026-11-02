import { describe, expect, it } from 'vitest'

import { projectConversationView } from '../src/renderer/features/workspace/conversation-view.js'
import type { WorkspaceConversationPageItem, WorkspaceExecutionEvent } from '../src/shared/schemas/workspace-store.js'

const RUN = 'run-1' as WorkspaceExecutionEvent['runId']
const BASE = Date.parse('2026-10-30T12:00:00.000Z')
const at = (seconds: number) => new Date(BASE + seconds * 1000).toISOString()

let nextSequence = 0

function record(
  kind: WorkspaceExecutionEvent['kind'],
  data: Record<string, unknown>,
  seconds: number,
  runId: WorkspaceExecutionEvent['runId'] = RUN,
): WorkspaceConversationPageItem {
  nextSequence += 1
  return {
    event: {
      sequence: nextSequence,
      schemaVersion: 1,
      kind,
      runId,
      taskId: 'task-1' as WorkspaceExecutionEvent['taskId'],
      generation: 1,
      occurredAt: at(seconds),
      data,
    },
  }
}

const driver = (event: Record<string, unknown>, seconds: number, runId?: WorkspaceExecutionEvent['runId']) =>
  record('driverEvent', { event }, seconds, runId)

const status = (kind: WorkspaceExecutionEvent['kind'], seconds: number) => record(kind, {}, seconds)

function turnRun(items: WorkspaceConversationPageItem[]) {
  const { entries } = projectConversationView(items)
  const turn = entries.find(entry => entry.kind === 'assistant')
  if (!turn || turn.kind !== 'assistant') throw new Error('Expected an assistant turn')
  return turn.run
}

describe('conversation run projection', () => {
  it('settles a completed Run with its start and terminal timestamps', () => {
    nextSequence = 0
    const items = [
      status('runStarted', 0),
      driver({ kind: 'toolStarted', toolCallId: 't1', name: 'Bash', input: '{"command":"npm test"}' }, 1),
      driver({ kind: 'toolCompleted', toolCallId: 't1' }, 2),
      driver({ kind: 'turnCompleted' }, 12.5),
    ]
    const run = turnRun(items)
    expect(run).toMatchObject({ status: 'completed', startedAt: at(0), settledAt: at(12.5), pendingRequestKind: null })
  })

  it('reports an interrupted Run and never reopens it from a non-turn record', () => {
    nextSequence = 0
    const items = [
      status('runStarted', 0),
      driver({ kind: 'textDelta', text: 'partial' }, 1),
      driver({ kind: 'turnInterrupted' }, 3),
      driver({ kind: 'textDelta', text: ' late' }, 4),
    ]
    expect(turnRun(items).status).toBe('interrupted')
  })

  it('keeps a failed Run failed even when a later delta arrives', () => {
    nextSequence = 0
    const items = [
      status('runStarted', 0),
      driver({ kind: 'turnFailed', message: 'boom' }, 1),
      driver({ kind: 'textDelta', text: 'after' }, 2),
    ]
    expect(turnRun(items).status).toBe('failed')
  })

  it('leaves startedAt unknown when the start record is not loaded', () => {
    nextSequence = 0
    const items = [driver({ kind: 'textDelta', text: 'hi' }, 5), driver({ kind: 'turnCompleted' }, 9)]
    const run = turnRun(items)
    expect(run).toMatchObject({ status: 'completed', startedAt: null, settledAt: at(9) })
  })

  it('reopens a settled Run when a new native turn starts', () => {
    nextSequence = 0
    const items = [
      status('runStarted', 0),
      driver({ kind: 'turnCompleted' }, 2),
      driver({ kind: 'turnStarted' }, 3),
      driver({ kind: 'textDelta', text: 'again' }, 4),
    ]
    expect(turnRun(items).status).toBe('active')
  })

  it('exposes the live activity of the latest Run and labels reasoning as thinking', () => {
    nextSequence = 0
    const projection = projectConversationView([
      status('runStarted', 0),
      driver({ kind: 'reasoningDelta', text: 'pondering' }, 1),
    ])
    expect(projection.activity).toMatchObject({ label: 'thinking', since: at(0) })
  })

  it('labels the live activity as working once visible output resumes after reasoning', () => {
    nextSequence = 0
    const projection = projectConversationView([
      status('runStarted', 0),
      driver({ kind: 'reasoningDelta', text: 'pondering' }, 1),
      driver({ kind: 'textDelta', text: 'answer' }, 2),
    ])
    expect(projection.activity?.label).toBe('working')
  })

  it('shows a queued Run as working from its first record', () => {
    nextSequence = 0
    const projection = projectConversationView([status('runQueued', 0)])
    expect(projection.activity).toMatchObject({ label: 'working', since: at(0) })
  })

  it('distinguishes approval and question waits', () => {
    nextSequence = 0
    const approval = projectConversationView([
      status('runStarted', 0),
      driver(
        {
          kind: 'requestPending',
          request: {
            requestId: 'r1',
            runId: RUN,
            generation: 1,
            kind: 'approval',
            prompt: 'Run tests?',
            questions: [],
          },
        },
        1,
      ),
    ])
    expect(approval.activity?.label).toBe('awaitingApproval')

    nextSequence = 0
    const question = projectConversationView([
      status('runStarted', 0),
      driver(
        {
          kind: 'requestPending',
          request: {
            requestId: 'r2',
            runId: RUN,
            generation: 1,
            kind: 'question',
            prompt: 'Which branch?',
            questions: [],
          },
        },
        1,
      ),
    ])
    expect(question.activity?.label).toBe('awaitingAnswer')
  })

  it('returns to working once the pending request is resolved', () => {
    nextSequence = 0
    const projection = projectConversationView([
      status('runStarted', 0),
      driver(
        {
          kind: 'requestPending',
          request: {
            requestId: 'r1',
            runId: RUN,
            generation: 1,
            kind: 'approval',
            prompt: 'Run tests?',
            questions: [],
          },
        },
        1,
      ),
      driver({ kind: 'requestResolved', requestId: 'r1', decision: { kind: 'approve' } }, 2),
    ])
    expect(projection.activity?.label).toBe('working')
  })

  it('reports no activity once the latest Run has settled', () => {
    nextSequence = 0
    const projection = projectConversationView([status('runStarted', 0), driver({ kind: 'turnCompleted' }, 4)])
    expect(projection.activity).toBeNull()
  })

  it('stamps each assistant turn with its first record time', () => {
    nextSequence = 0
    const projection = projectConversationView([status('runStarted', 0), driver({ kind: 'textDelta', text: 'a' }, 3)])
    const turn = projection.entries.find(entry => entry.kind === 'assistant')
    expect(turn).toMatchObject({ kind: 'assistant', occurredAt: at(3) })
  })
})
