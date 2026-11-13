import type { AgentRequest, AgentRequestDecision } from '@/shared/schemas/execution.js'
import type { TaskId } from '@/shared/schemas/workspace.js'
import type { WorkspacePendingRuntimeRequest } from '@/shared/schemas/workspace-store.js'

import type { WorkspaceRequest } from './lib.js'
import { approvalDecision, eligibleApprovalOptions, validatedQuestionAnswer } from './request-controls.js'

export const PENDING_REQUEST_PAGE_SIZE = 50

/** The first pending-request page. The drawer and the composer read the same page, so they share one query. */
export const firstPendingRequest = (taskId: TaskId): WorkspaceRequest<'workspace:listPendingRuntimeRequests'> => ({
  taskId,
  afterSequence: 0,
  limit: PENDING_REQUEST_PAGE_SIZE,
})

type ApprovalOption = NonNullable<AgentRequest['options']>[number]
type Question = AgentRequest['questions'][number]

export interface ApprovalAction {
  readonly option: ApprovalOption
  readonly decision: AgentRequestDecision
}

/** The approval buttons the drawer shows: a primary approve, a decline, and the rest behind a menu. */
export interface ApprovalActions {
  readonly approve: ApprovalAction | null
  readonly decline: ApprovalAction | null
  readonly more: readonly ApprovalAction[]
  /** Native options whose response semantics are unknown; they are listed but cannot be chosen. */
  readonly unavailable: readonly ApprovalOption[]
}

const isBroadScope = (option: ApprovalOption) => option.scope === 'session' || option.scope === 'project'

/** Splits native approval options by the decision they send, preferring a single-use approval as primary. */
export function approvalActions(request: AgentRequest): ApprovalActions {
  const eligible = new Set(eligibleApprovalOptions(request).map(option => option.id))
  const actions: ApprovalAction[] = []
  const unavailable: ApprovalOption[] = []
  for (const option of request.options ?? []) {
    const decision = eligible.has(option.id) ? approvalDecision(request, option) : null
    if (decision) actions.push({ option, decision })
    else unavailable.push(option)
  }
  const approvals = actions.filter(action => action.decision.kind === 'approve')
  const approve = approvals.find(action => !isBroadScope(action.option)) ?? approvals[0] ?? null
  const decline = actions.find(action => action.decision.kind === 'deny') ?? null
  return {
    approve,
    decline,
    more: actions.filter(action => action !== approve && action !== decline),
    unavailable,
  }
}

export type QuestionAnswers = Readonly<Record<string, string | readonly string[]>>

/** Whether one question has an answer the agent will accept. */
export function isQuestionAnswered(question: Question, answer: QuestionAnswers[string] | undefined): boolean {
  return validatedQuestionAnswer(question, answer) !== null
}

/** Picks an option: single-select replaces the answer, multi-select toggles membership. */
export function chooseQuestionOption(question: Question, answers: QuestionAnswers, optionId: string): QuestionAnswers {
  if (!question.options.some(option => option.id === optionId)) return answers
  if (!question.multiSelect) return { ...answers, [question.id]: optionId }
  const current = answers[question.id]
  const values = Array.isArray(current) ? current : []
  return {
    ...answers,
    [question.id]: values.includes(optionId) ? values.filter(id => id !== optionId) : [...values, optionId],
  }
}

export function questionCustomAnswer(question: Question, answers: QuestionAnswers): string {
  const answer = answers[question.id]
  const values = typeof answer === 'string' ? [answer] : (answer ?? [])
  return values.find(value => !question.options.some(option => option.id === value)) ?? ''
}

export function setQuestionCustomAnswer(question: Question, answers: QuestionAnswers, text: string): QuestionAnswers {
  if (question.options.length > 0 && question.allowCustomAnswer !== true) return answers
  if (!question.multiSelect) return { ...answers, [question.id]: text }
  const previous = answers[question.id]
  const selections = Array.isArray(previous)
    ? previous.filter(value => question.options.some(option => option.id === value))
    : []
  return { ...answers, [question.id]: text.trim().length > 0 ? [...selections, text] : selections }
}

export interface QuestionDraft {
  readonly answers: QuestionAnswers
  readonly index: number
}

const questionDrafts = new Map<string, QuestionDraft>()
const MAX_QUESTION_DRAFTS = 80

function questionDraftKey(request: AgentRequest): string {
  return `${request.runId}:${request.generation}:${request.requestId}`
}

/** Drafts stay in the renderer's memory, including secret answers; no browser storage is used. */
export function readQuestionDraft(request: AgentRequest): QuestionDraft {
  return questionDrafts.get(questionDraftKey(request)) ?? { answers: {}, index: 0 }
}

export function rememberQuestionDraft(request: AgentRequest, draft: QuestionDraft): void {
  const key = questionDraftKey(request)
  questionDrafts.delete(key)
  questionDrafts.set(key, draft)
  while (questionDrafts.size > MAX_QUESTION_DRAFTS) {
    const oldest = questionDrafts.keys().next().value
    if (oldest === undefined) break
    questionDrafts.delete(oldest)
  }
}

export function forgetQuestionDraft(request: AgentRequest): void {
  questionDrafts.delete(questionDraftKey(request))
}

export interface QuestionProgress {
  readonly question: Question | null
  /** Clamped to the question list. */
  readonly index: number
  readonly total: number
  readonly isLast: boolean
  /** The shown question is answered, so Next or Submit can proceed. */
  readonly canAdvance: boolean
  /** Every question is answered. */
  readonly complete: boolean
}

/** One question at a time: where the drawer stands and what it may do next. */
export function questionProgress(
  questions: readonly Question[],
  answers: QuestionAnswers,
  index: number,
): QuestionProgress {
  const total = questions.length
  const clamped = total === 0 ? 0 : Math.min(Math.max(index, 0), total - 1)
  const question = questions[clamped] ?? null
  return {
    question,
    index: clamped,
    total,
    isLast: clamped >= total - 1,
    canAdvance: question !== null && isQuestionAnswered(question, answers[question.id]),
    complete: total > 0 && questions.every(item => isQuestionAnswered(item, answers[item.id])),
  }
}

/** Digits 1–9 choose the matching option, unless a modifier is held. */
export function digitShortcutIndex(
  event: { readonly key: string; readonly metaKey: boolean; readonly ctrlKey: boolean; readonly altKey: boolean },
  optionCount: number,
): number | null {
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  if (!/^[1-9]$/.test(event.key)) return null
  const index = Number(event.key) - 1
  return index < optionCount ? index : null
}

/** Answerable requests first, oldest first, so the drawer always shows what is blocking the agent. */
export function orderRequestsForDrawer<T extends Pick<WorkspacePendingRuntimeRequest, 'sequence'>>(
  items: readonly T[],
  isCurrent: (item: T) => boolean,
): { readonly active: T | null; readonly waiting: readonly T[]; readonly stale: readonly T[] } {
  const ordered = [...items].sort((a, b) => a.sequence - b.sequence)
  const current = ordered.filter(isCurrent)
  return {
    active: current[0] ?? null,
    waiting: current.slice(1),
    stale: ordered.filter(item => !isCurrent(item)),
  }
}
