import { describe, expect, it } from 'vitest'

import {
  applyWorkspaceFrame,
  createWorkspaceProjection,
  workspaceResume,
} from '../src/renderer/features/workspace/events.js'
import type { WorkspaceEventFrame } from '../src/shared/rpc/workspace.js'
import type { WorkspaceExecutionEvent } from '../src/shared/schemas/workspace-store.js'

const event = (
  sequence: number,
  kind: WorkspaceExecutionEvent['kind'] = 'runQueued',
  data: Record<string, unknown> = {},
): WorkspaceExecutionEvent => ({
  sequence,
  schemaVersion: 1,
  kind,
  runId: 'run-1' as WorkspaceExecutionEvent['runId'],
  taskId: 'task-1' as WorkspaceExecutionEvent['taskId'],
  generation: 1,
  occurredAt: '2026-10-30T12:00:00Z',
  data,
})
const frame = (
  events: WorkspaceExecutionEvent[],
  throughSequence = events.at(-1)?.sequence ?? 0,
  hasMore = false,
): WorkspaceEventFrame => ({
  protocolVersion: 1,
  _tag: 'Snapshot',
  throughSequence,
  page: {
    events,
    highWatermark: throughSequence,
    hasMore,
    nextAfterSequence: hasMore ? (events.at(-1)?.sequence ?? null) : null,
  },
})

describe('workspace event projection', () => {
  it('orders a page and applies duplicate replay only once', () => {
    const first = applyWorkspaceFrame(createWorkspaceProjection(), frame([event(2), event(1)], 2)).state
    expect(first.lastAppliedSequence).toBe(2)
    expect(first.tasks['task-1']?.transcript.map(item => item.sequence)).toEqual([1, 2])
    const replay = applyWorkspaceFrame(first, frame([event(1), event(2)], 2))
    expect(replay.state).toEqual(first)
    expect(replay.applied).toEqual([])
  })
})

it('stops at a gap and resumes from the last contiguous event on overflow or disconnect', () => {
  const result = applyWorkspaceFrame(createWorkspaceProjection(), frame([event(1), event(3)], 3))
  expect(result.state.lastAppliedSequence).toBe(1)
  expect(result.resubscribe).toBe(true)
  expect(workspaceResume(result.state, 0)).toEqual({ afterSequence: 1, delayMs: 100 })
  expect(workspaceResume(result.state, 100)).toEqual({ afterSequence: 1, delayMs: 3000 })
  const resumed = applyWorkspaceFrame(result.state, frame([event(2), event(3)], 3))
  expect(resumed.state.lastAppliedSequence).toBe(3)
  expect(resumed.resubscribe).toBe(false)
})

it('detects an incomplete final page but accepts an empty caught-up snapshot', () => {
  expect(applyWorkspaceFrame(createWorkspaceProjection(), frame([], 2)).resubscribe).toBe(true)
  expect(applyWorkspaceFrame(createWorkspaceProjection(), frame([])).resubscribe).toBe(false)
})

it('bounds retained transcript items while preserving run state and paging provenance', () => {
  const result = applyWorkspaceFrame(
    createWorkspaceProjection({ transcriptLimit: 2 }),
    frame([event(1), event(2, 'runStarted'), event(3, 'driverEvent', { event: { kind: 'textDelta', text: 'hello' } })]),
  )
  expect(result.state.tasks['task-1']?.transcript.map(item => item.sequence)).toEqual([2, 3])
  expect(result.state.tasks['task-1']?.truncatedBeforeSequence).toBe(2)
  expect(result.state.tasks['task-1']?.runs['run-1']?.status).toBe('running')
})

it('derives waiting, failed, interrupted and uncertain delivery attention independently of transcript retention', () => {
  let state = createWorkspaceProjection({ transcriptLimit: 1 })
  state = applyWorkspaceFrame(
    state,
    frame([
      event(1, 'driverEvent', {
        event: {
          kind: 'requestPending',
          request: {
            requestId: 'request-1',
            runId: 'run-1',
            generation: 1,
            kind: 'approval',
            prompt: 'Allow?',
            questions: [],
          },
        },
      }),
    ]),
  ).state
  expect(state.tasks['task-1']?.attention.waitingRequest).toBe(true)
  state = applyWorkspaceFrame(state, frame([event(2, 'requestResponseRecorded', { requestId: 'request-1' })])).state
  expect(state.tasks['task-1']?.attention.waitingRequest).toBe(true)
  state = applyWorkspaceFrame(
    state,
    frame([event(3, 'requestResponseSettled', { requestId: 'request-1', outcome: 'uncertain' })]),
  ).state
  expect(state.tasks['task-1']?.attention.uncertainDelivery).toBe(true)
  state = applyWorkspaceFrame(
    state,
    frame([
      event(4, 'driverEvent', {
        event: { kind: 'requestResolved', requestId: 'request-1', decision: { kind: 'approve' } },
      }),
    ]),
  ).state
  expect(state.tasks['task-1']?.attention.waitingRequest).toBe(false)
  state = applyWorkspaceFrame(
    state,
    frame([event(5, 'driverEvent', { event: { kind: 'turnFailed', message: 'No' } })]),
  ).state
  expect(state.tasks['task-1']?.attention.failed).toBe(true)
  state = applyWorkspaceFrame(
    state,
    frame([
      {
        ...event(6, 'driverEvent', { event: { kind: 'turnInterrupted' } }),
        runId: 'run-2' as WorkspaceExecutionEvent['runId'],
      },
    ]),
  ).state
  expect(state.tasks['task-1']?.attention.interrupted).toBe(true)
  expect(state.tasks['task-1']?.attention.failed).toBe(true)
})

it('keeps summarized events incomplete and does not invent a driver event', () => {
  const result = applyWorkspaceFrame(
    createWorkspaceProjection(),
    frame([
      {
        ...event(1, 'driverEvent'),
        payloadTruncated: true,
        payloadRef: { kind: 'event', id: '1', digest: 'a'.repeat(64) },
      },
    ]),
  )
  expect(result.state.tasks['task-1']?.attention.incompletePayload).toBe(true)
  expect(result.state.tasks['task-1']?.transcript[0]?.payloadRef?.id).toBe('1')
})

it('bounds inactive task and Run summaries as well as transcripts', () => {
  const state = applyWorkspaceFrame(
    createWorkspaceProjection({ taskLimit: 1, runLimit: 1 }),
    frame([
      event(1),
      { ...event(2), taskId: 'task-2' as WorkspaceExecutionEvent['taskId'] },
      {
        ...event(3),
        taskId: 'task-2' as WorkspaceExecutionEvent['taskId'],
        runId: 'run-2' as WorkspaceExecutionEvent['runId'],
      },
    ]),
  ).state
  expect(Object.keys(state.tasks)).toEqual(['task-2'])
  expect(Object.keys(state.tasks['task-2']?.runs ?? {})).toEqual(['run-2'])
  expect(state.lastAppliedSequence).toBe(3)
})

it('keeps waiting attention until native resolution and clears it on a terminal Run', () => {
  const pending = event(1, 'driverEvent', {
    event: {
      kind: 'requestPending',
      request: {
        requestId: 'request-1',
        runId: 'run-1',
        generation: 1,
        kind: 'approval',
        prompt: 'Allow?',
        questions: [],
      },
    },
  })
  const state = applyWorkspaceFrame(
    createWorkspaceProjection(),
    frame([pending, event(2, 'requestResponseSettled', { outcome: 'accepted', requestId: 'request-1' })]),
  ).state
  expect(state.tasks['task-1']?.attention.waitingRequest).toBe(true)
  const completed = applyWorkspaceFrame(
    state,
    frame([event(3, 'driverEvent', { event: { kind: 'turnCompleted' } })]),
  ).state
  expect(completed.tasks['task-1']?.attention.waitingRequest).toBe(false)
  expect(completed.tasks['task-1']?.runs['run-1']?.status).toBe('completed')
})

it('retains Conversation and native turn identity for live transcript routing and steering', () => {
  const state = applyWorkspaceFrame(
    createWorkspaceProjection(),
    frame([
      event(1, 'runQueued', { conversationId: 'conversation-1' }),
      event(2, 'runStarted', { nativeTurnId: 'turn-1' }),
    ]),
  ).state
  expect(state.tasks['task-1']?.runs['run-1']?.conversationId).toBe('conversation-1')
  expect(state.tasks['task-1']?.runs['run-1']?.nativeTurnId).toBe('turn-1')
})

it('surfaces failed delivery without falsely terminating a running Run', () => {
  const state = applyWorkspaceFrame(
    createWorkspaceProjection(),
    frame([event(1, 'runStarted'), event(2, 'steerSettled', { outcome: 'failed' })]),
  ).state
  expect(state.tasks['task-1']?.runs['run-1']?.status).toBe('running')
  expect(state.tasks['task-1']?.attention.failed).toBe(true)
})

it('resubscribes when a nonfinal page cannot advance its cursor', () => {
  expect(applyWorkspaceFrame(createWorkspaceProjection(), frame([], 2, true)).resubscribe).toBe(true)
})

it('bounds request identities without losing waiting attention for requests outside the retained tail', () => {
  const pending = Array.from({ length: 51 }, (_, index) =>
    event(index + 1, 'driverEvent', {
      event: {
        kind: 'requestPending',
        request: {
          requestId: `request-${index + 1}`,
          runId: 'run-1',
          generation: 1,
          kind: 'approval',
          prompt: 'Allow?',
          questions: [],
        },
      },
    }),
  )
  const resolved = Array.from({ length: 50 }, (_, index) =>
    event(index + 52, 'driverEvent', {
      event: {
        kind: 'requestResolved',
        requestId: `request-${index + 2}`,
        decision: { kind: 'approve' },
      },
    }),
  )
  const state = applyWorkspaceFrame(
    createWorkspaceProjection({ transcriptLimit: 1 }),
    frame([...pending, ...resolved]),
  ).state
  expect(state.tasks['task-1']?.attention.waitingRequest).toBe(true)
  const complete = applyWorkspaceFrame(
    state,
    frame([
      event(102, 'driverEvent', {
        event: { kind: 'requestResolved', requestId: 'request-1', decision: { kind: 'approve' } },
      }),
    ]),
  ).state
  expect(complete.tasks['task-1']?.attention.waitingRequest).toBe(false)
})
