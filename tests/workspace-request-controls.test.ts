import { describe, expect, it } from 'vitest'

import {
  approvalDecision,
  eligibleApprovalOptions,
  questionAnswerLabels,
  questionDecision,
  requestIsCurrent,
  requestLabel,
  requestResponseState,
} from '../src/renderer/features/workspace/request-controls.js'
import type { AgentRequest, AgentRun } from '../src/shared/schemas/execution.js'
import type { WorkspacePendingRuntimeRequest, WorkspaceRunContext } from '../src/shared/schemas/workspace-store.js'

const approval: AgentRequest = {
  requestId: 'request-a',
  runId: 'run-a' as AgentRequest['runId'],
  generation: 2,
  kind: 'approval',
  prompt: 'Run a command in this checkout?',
  options: [
    { id: 'once', label: 'Allow once', scope: 'once', kind: 'allow' },
    { id: 'session', label: 'Allow for session', scope: 'session', kind: 'allowAlways' },
    { id: 'decline', label: 'Decline', kind: 'deny', decision: { kind: 'deny' } },
    { id: 'cancel', label: 'Cancel turn', kind: 'deny', decision: { kind: 'cancel' } },
  ],
  questions: [],
}

const pending: WorkspacePendingRuntimeRequest = {
  taskId: 'task-a' as WorkspacePendingRuntimeRequest['taskId'],
  runId: 'run-a' as WorkspacePendingRuntimeRequest['runId'],
  sequence: 1,
  request: approval,
}

const run: AgentRun = {
  id: pending.runId,
  taskId: pending.taskId,
  attempt: 1,
  generation: 2,
  status: 'awaitingInput',
  submittedAt: '2026-11-02T10:00:00Z',
}

const context: WorkspaceRunContext = {
  runId: pending.runId,
  conversationId: 'conversation-a' as WorkspaceRunContext['conversationId'],
  checkoutId: 'checkout-a' as WorkspaceRunContext['checkoutId'],
  driverId: 'driver-a',
  connectionId: 'connection-a',
}

describe('workspace request controls', () => {
  it('labels approvals by the tool category when the driver supplies one', () => {
    expect(requestLabel({ ...approval, tool: { category: 'command' } })).toBe('Command approval')
    expect(requestLabel({ ...approval, tool: { category: 'fileRead' } })).toBe('File read approval')
    expect(requestLabel({ ...approval, tool: { category: 'fileWrite' } })).toBe('File change approval')
    expect(requestLabel({ ...approval, tool: { category: 'mcp' } })).toBe('App access approval')
    expect(requestLabel(approval)).toBe('Approval requested')
  })

  it('preserves exact one-shot, decline and cancel choices while disabling scope widening', () => {
    const options = approval.options ?? []
    const [once, session, decline, cancel] = options
    if (once === undefined || session === undefined || decline === undefined || cancel === undefined)
      throw new Error('Approval fixture is incomplete.')
    expect(eligibleApprovalOptions(approval).map(option => option.id)).toEqual(['once', 'decline', 'cancel'])
    expect(approvalDecision(approval, once)).toEqual({ kind: 'approve', optionId: 'once' })
    expect(approvalDecision(approval, session)).toBeNull()
    expect(approvalDecision(approval, decline)).toEqual({ kind: 'deny' })
    expect(approvalDecision(approval, cancel)).toEqual({ kind: 'cancel' })
  })

  it('accepts exact single, multiple and empty-option text answers without default selections', () => {
    const question: AgentRequest = {
      ...approval,
      kind: 'question',
      options: undefined,
      questions: [
        {
          id: 'choice',
          prompt: 'Choose one',
          multiSelect: false,
          options: [
            { id: 'choice-a', label: 'A' },
            { id: 'choice-b', label: 'B' },
          ],
        },
        {
          id: 'many',
          prompt: 'Choose any',
          multiSelect: true,
          options: [
            { id: 'many-a', label: 'A' },
            { id: 'many-b', label: 'B' },
          ],
        },
        { id: 'text', prompt: 'Answer', multiSelect: false, options: [] },
      ],
    }
    expect(questionDecision(question, {})).toBeNull()
    expect(
      questionDecision(question, { choice: 'choice-b', many: ['many-a', 'many-b'], text: 'typed answer' }),
    ).toEqual({
      kind: 'answers',
      answers: { choice: 'choice-b', many: ['many-a', 'many-b'], text: 'typed answer' },
    })
    expect(questionDecision(question, { choice: 'not-an-option', many: ['many-a'], text: 'x' })).toBeNull()
    expect(questionDecision(question, { choice: ['choice-a'], many: ['many-a'], text: 'x' })).toBeNull()
    expect(questionDecision(question, { choice: 'choice-a', many: [], text: 'x' })).toBeNull()
  })

  it('fences requests by conversation, active status and generation', () => {
    expect(requestIsCurrent(pending, 'conversation-a', [run], [context])).toBe(true)
    expect(requestIsCurrent(pending, 'conversation-b', [run], [context])).toBe(false)
    expect(requestIsCurrent(pending, 'conversation-a', [{ ...run, status: 'completed' }], [context])).toBe(false)
    expect(requestIsCurrent(pending, 'conversation-a', [{ ...run, generation: 1 }], [context])).toBe(false)
    expect(requestIsCurrent(pending, 'conversation-a', [run], [])).toBe(false)
  })

  it('accepts custom answers only when advertised and keeps multi-select option IDs alongside typed text', () => {
    const request: AgentRequest = {
      ...approval,
      kind: 'question',
      questions: [
        {
          id: 'target',
          prompt: 'Targets?',
          multiSelect: true,
          allowCustomAnswer: true,
          options: [
            { id: 'web', label: 'Web' },
            { id: 'desktop', label: 'Desktop' },
          ],
        },
      ],
    }
    expect(questionDecision(request, { target: ['web', 'A custom target'] })).toEqual({
      kind: 'answers',
      answers: { target: ['web', 'A custom target'] },
    })
    expect(
      questionDecision(
        { ...request, questions: [{ ...request.questions[0], allowCustomAnswer: false }] },
        { target: ['web', 'A custom target'] },
      ),
    ).toBeNull()
    expect(questionDecision(request, { target: ['web', 'web'] })).toBeNull()
    expect(questionDecision(request, { target: ['web', '   '] })).toBeNull()
  })

  it('resolves saved option IDs to labels while masking secret answers in history', () => {
    const question: AgentRequest['questions'][number] = {
      id: 'choice',
      prompt: 'Choose',
      multiSelect: true,
      options: [{ id: 'one', label: 'First answer' }],
      allowCustomAnswer: true,
    }
    const decision = { kind: 'answers' as const, answers: { choice: ['one', 'My answer'] } }
    expect(questionAnswerLabels(question, decision)).toEqual(['First answer', 'My answer'])
    expect(questionAnswerLabels({ ...question, isSecret: true }, decision)).toEqual(['Hidden answer'])
    expect(questionAnswerLabels(question, { kind: 'cancel' })).toEqual([])
  })

  it('looks up response delivery independently by run, generation and request identity', () => {
    const responses = [
      {
        commandId: 'response-a',
        issuedAt: '2026-11-02T10:00:00Z',
        ownerEpoch: 1,
        decision: { kind: 'approve' as const, optionId: 'allow-once' },
        runId: pending.runId,
        generation: 2,
        requestId: approval.requestId,
        state: 'uncertain' as const,
        position: 1,
      },
      {
        commandId: 'response-b',
        issuedAt: '2026-11-02T10:00:00Z',
        ownerEpoch: 1,
        decision: { kind: 'deny' as const },
        runId: pending.runId,
        generation: 2,
        requestId: approval.requestId,
        state: 'accepted' as const,
        position: 2,
      },
    ]
    expect(requestResponseState(responses, pending.runId, 2, approval.requestId)).toBe('accepted')
    expect(requestResponseState(responses, pending.runId, 1, approval.requestId)).toBeNull()
  })
})
