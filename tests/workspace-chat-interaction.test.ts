import { describe, expect, it } from 'vitest'

import {
  composerPlaceholder,
  isStopPrimary,
  resolveComposerDispatch,
} from '../src/renderer/features/workspace/composer-state.js'
import { projectConversationView } from '../src/renderer/features/workspace/conversation-view.js'
import {
  approvalActions,
  chooseQuestionOption,
  digitShortcutIndex,
  forgetQuestionDraft,
  orderRequestsForDrawer,
  questionCustomAnswer,
  questionProgress,
  readQuestionDraft,
  rememberQuestionDraft,
  setQuestionCustomAnswer,
} from '../src/renderer/features/workspace/request-drawer-state.js'
import type { AgentRequest } from '../src/shared/schemas/execution.js'
import type { WorkspaceConversationPageItem, WorkspaceExecutionEvent } from '../src/shared/schemas/workspace-store.js'

const RUN = 'run-a' as AgentRequest['runId']

const approval: AgentRequest = {
  requestId: 'approval',
  runId: RUN,
  generation: 1,
  kind: 'approval',
  prompt: 'git status',
  options: [
    { id: 'session', label: 'Allow for session', scope: 'session', kind: 'allowAlways', decision: { kind: 'approve' } },
    { id: 'once', label: 'Allow once', scope: 'once', kind: 'allow' },
    { id: 'decline', label: 'Decline', kind: 'deny', decision: { kind: 'deny' } },
    { id: 'cancel', label: 'Cancel turn', kind: 'deny', decision: { kind: 'cancel' } },
    { id: 'project', label: 'Allow for project', scope: 'project', kind: 'allowAlways' },
  ],
  questions: [],
}

type Question = AgentRequest['questions'][number]
const branch: Question = {
  id: 'branch',
  prompt: 'Which branch?',
  multiSelect: false,
  options: [
    { id: 'main', label: 'main' },
    { id: 'dev', label: 'dev' },
  ],
}
const checks: Question = {
  id: 'checks',
  prompt: 'Which checks?',
  multiSelect: true,
  options: [
    { id: 'lint', label: 'Lint' },
    { id: 'test', label: 'Test' },
  ],
}
const note: Question = { id: 'note', prompt: 'Anything else?', multiSelect: false, options: [] }
const questions = [branch, checks, note]

describe('request drawer approvals', () => {
  it('prefers a single-use approval as primary and keeps broader or cancel choices in the menu', () => {
    const actions = approvalActions(approval)
    expect(actions.approve?.option.id).toBe('once')
    expect(actions.approve?.decision).toEqual({ kind: 'approve', optionId: 'once' })
    expect(actions.decline?.option.id).toBe('decline')
    expect(actions.more.map(action => action.option.id)).toEqual(['session', 'cancel'])
    expect(actions.unavailable.map(option => option.id)).toEqual(['project'])
  })

  it('falls back to a broad approval when no single-use one is offered', () => {
    const actions = approvalActions({ ...approval, options: approval.options?.slice(0, 1) ?? [] })
    expect(actions.approve?.option.id).toBe('session')
    expect(actions.decline).toBeNull()
  })
})

describe('request drawer questions', () => {
  it('keeps selected options when a multi-select custom answer is changed or cleared', () => {
    const question = { ...checks, allowCustomAnswer: true }
    let answers = chooseQuestionOption(question, {}, 'lint')
    answers = setQuestionCustomAnswer(question, answers, 'Build the desktop app')
    expect(answers[question.id]).toEqual(['lint', 'Build the desktop app'])
    expect(questionCustomAnswer(question, answers)).toBe('Build the desktop app')
    answers = setQuestionCustomAnswer(question, answers, 'Run in CI')
    expect(answers[question.id]).toEqual(['lint', 'Run in CI'])
    answers = setQuestionCustomAnswer(question, answers, '')
    expect(answers[question.id]).toEqual(['lint'])
    const strictAnswers = { [checks.id]: ['test'] }
    expect(setQuestionCustomAnswer(checks, strictAnswers, 'Not advertised')).toBe(strictAnswers)
  })

  it('remembers answers and the selected question by Run, generation and request identity', () => {
    const request = { ...approval, kind: 'question' as const, questions }
    const draft = { answers: { branch: 'dev', checks: ['lint'] }, index: 1 }
    rememberQuestionDraft(request, draft)
    expect(readQuestionDraft(request)).toEqual(draft)
    expect(readQuestionDraft({ ...request, generation: request.generation + 1 })).toEqual({ answers: {}, index: 0 })
    expect(readQuestionDraft({ ...request, requestId: 'another-request' })).toEqual({ answers: {}, index: 0 })
    forgetQuestionDraft(request)
    expect(readQuestionDraft(request)).toEqual({ answers: {}, index: 0 })
  })
  it('walks one question at a time and completes only when every answer is present', () => {
    let answers = {}
    expect(questionProgress(questions, answers, 0)).toMatchObject({ index: 0, total: 3, canAdvance: false })
    answers = chooseQuestionOption(branch, answers, 'dev')
    expect(questionProgress(questions, answers, 0)).toMatchObject({ canAdvance: true, complete: false })
    answers = chooseQuestionOption(checks, answers, 'lint')
    answers = chooseQuestionOption(checks, answers, 'test')
    answers = chooseQuestionOption(checks, answers, 'lint')
    expect(answers).toMatchObject({ branch: 'dev', checks: ['test'] })
    answers = { ...answers, note: '   ' }
    expect(questionProgress(questions, answers, 2)).toMatchObject({ isLast: true, canAdvance: false, complete: false })
    answers = { ...answers, note: 'ship it' }
    expect(questionProgress(questions, answers, 2)).toMatchObject({ canAdvance: true, complete: true })
  })

  it('clamps the index and ignores options from another question', () => {
    expect(questionProgress(questions, {}, 9)).toMatchObject({ index: 2, isLast: true })
    expect(questionProgress([], {}, 0)).toMatchObject({ question: null, complete: false })
    const answers = { branch: 'main' }
    expect(chooseQuestionOption(branch, answers, 'lint')).toBe(answers)
  })

  it('maps digits to options unless a modifier is held or the option does not exist', () => {
    const key = (value: string, modifier = false) => ({ key: value, metaKey: false, ctrlKey: modifier, altKey: false })
    expect(digitShortcutIndex(key('1'), 2)).toBe(0)
    expect(digitShortcutIndex(key('2'), 2)).toBe(1)
    expect(digitShortcutIndex(key('3'), 2)).toBeNull()
    expect(digitShortcutIndex(key('0'), 2)).toBeNull()
    expect(digitShortcutIndex(key('1', true), 2)).toBeNull()
  })

  it('surfaces the oldest answerable request and separates stale ones', () => {
    const items = [
      { sequence: 9, id: 'late' },
      { sequence: 3, id: 'stale' },
      { sequence: 5, id: 'early' },
    ]
    const order = orderRequestsForDrawer(items, item => item.id !== 'stale')
    expect(order.active?.id).toBe('early')
    expect(order.waiting.map(item => item.id)).toEqual(['late'])
    expect(order.stale.map(item => item.id)).toEqual(['stale'])
  })
})

describe('composer primary action', () => {
  it('sends when idle, queues while running and steers only with the alternate modifier when supported', () => {
    expect(resolveComposerDispatch({ busy: false, canSteer: true, alternate: true })).toBe('send')
    expect(resolveComposerDispatch({ busy: true, canSteer: true, alternate: false })).toBe('queue')
    expect(resolveComposerDispatch({ busy: true, canSteer: true, alternate: true })).toBe('steer')
    expect(resolveComposerDispatch({ busy: true, canSteer: false, alternate: true })).toBe('queue')
  })

  it('promotes Stop only while running with nothing to send', () => {
    expect(isStopPrimary({ busy: true, canStop: true, hasContent: false })).toBe(true)
    expect(isStopPrimary({ busy: true, canStop: true, hasContent: true })).toBe(false)
    expect(isStopPrimary({ busy: true, canStop: false, hasContent: false })).toBe(false)
    expect(isStopPrimary({ busy: false, canStop: true, hasContent: false })).toBe(false)
  })

  it('points the placeholder at what the agent waits for', () => {
    expect(composerPlaceholder({ busy: false, awaiting: null, canSteer: false })).toBeUndefined()
    expect(composerPlaceholder({ busy: true, awaiting: 'question', canSteer: true })).toMatch(/Answer the question/)
    expect(composerPlaceholder({ busy: true, awaiting: 'approval', canSteer: false })).toMatch(/Approve or decline/)
    expect(composerPlaceholder({ busy: true, awaiting: null, canSteer: true })).toMatch(/Ctrl\+Enter to steer/)
  })
})

describe('request rows in the transcript', () => {
  let sequence = 0
  const driver = (event: Record<string, unknown>): WorkspaceConversationPageItem => {
    sequence += 1
    return {
      event: {
        sequence,
        schemaVersion: 1,
        kind: 'driverEvent',
        runId: RUN as WorkspaceExecutionEvent['runId'],
        taskId: 'task-a' as WorkspaceExecutionEvent['taskId'],
        generation: 1,
        occurredAt: new Date(Date.UTC(2026, 10, 2, 12, 0, sequence)).toISOString(),
        data: { event },
      },
    }
  }
  const requestBlocks = (items: WorkspaceConversationPageItem[]) =>
    projectConversationView(items).entries.flatMap(entry =>
      entry.kind === 'assistant' ? entry.blocks.filter(block => block.kind === 'request') : [],
    )

  it('updates the pending row in place when the request resolves', () => {
    sequence = 0
    const blocks = requestBlocks([
      driver({ kind: 'turnStarted', nativeTurnId: 'native-1' }),
      driver({ kind: 'requestPending', request: approval }),
      driver({ kind: 'requestResolved', requestId: 'approval', decision: { kind: 'deny' } }),
    ])
    expect(blocks).toEqual([
      expect.objectContaining({
        requestId: 'approval',
        requestKind: 'approval',
        prompt: 'git status',
        outcome: 'declined',
      }),
    ])
  })

  it('resolves a request whose pending record belongs to an earlier turn of the same Run', () => {
    sequence = 0
    const items = [
      driver({ kind: 'turnStarted', nativeTurnId: 'native-1' }),
      driver({ kind: 'requestPending', request: { ...approval, kind: 'question', questions } }),
      driver({ kind: 'turnStarted', nativeTurnId: 'native-2' }),
      driver({ kind: 'requestResolved', requestId: 'approval', decision: { kind: 'answers', answers: {} } }),
    ]
    expect(requestBlocks(items)).toEqual([expect.objectContaining({ requestKind: 'question', outcome: 'answered' })])
  })

  it('keeps an orphan resolution visible when its pending record is not loaded', () => {
    sequence = 0
    const blocks = requestBlocks([
      driver({ kind: 'requestResolved', requestId: 'missing', decision: { kind: 'approve' } }),
    ])
    expect(blocks).toEqual([expect.objectContaining({ requestKind: null, prompt: null, outcome: 'approved' })])
  })
})
