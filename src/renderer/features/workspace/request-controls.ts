import type { AgentRequest, AgentRequestDecision, AgentRun } from '@/shared/schemas/execution.js'
import type { WorkspacePendingRuntimeRequest, WorkspaceRunContext } from '@/shared/schemas/workspace-store.js'

import type { WorkspaceResult } from './lib.js'

type RequestResponseHistoryItem = WorkspaceResult<'workspace:listRequestResponses'>['items'][number]

export type ResponseDeliveryState = 'pending' | 'accepted' | 'failed' | 'uncertain'

/** Names the kind of work that an approval would authorize when the driver supplied it. */
export function requestLabel(request: AgentRequest): string {
  if (request.kind === 'question') return request.questions.length > 1 ? 'Questions' : 'Question'

  switch (request.tool?.category) {
    case 'command':
      return 'Command approval'
    case 'fileRead':
      return 'File read approval'
    case 'fileWrite':
      return 'File change approval'
    case 'search':
      return 'Search approval'
    case 'web':
      return 'Web access approval'
    case 'subagent':
      return 'Subagent approval'
    case 'mcp':
      return 'App access approval'
    default:
      return 'Approval requested'
  }
}

export function requestResponseState(
  responses: ReadonlyArray<RequestResponseHistoryItem>,
  runId: string,
  generation: number,
  requestId: string,
): ResponseDeliveryState | 'resolved' | null {
  let latest: RequestResponseHistoryItem | undefined
  for (const response of responses) {
    if (
      response.runId === runId &&
      response.generation === generation &&
      response.requestId === requestId &&
      (!latest || response.position > latest.position)
    ) {
      latest = response
    }
  }
  return latest?.state ?? null
}

export function requestIsCurrent(
  request: WorkspacePendingRuntimeRequest,
  conversationId: string,
  runs: ReadonlyArray<AgentRun>,
  runContexts: ReadonlyArray<WorkspaceRunContext>,
): boolean {
  const run = runs.find(item => item.id === request.runId)
  const context = runContexts.find(item => item.runId === request.runId)
  return (
    run !== undefined &&
    context?.conversationId === conversationId &&
    run.generation === request.request.generation &&
    (run.status === 'running' || run.status === 'awaitingInput')
  )
}

export function eligibleApprovalOptions(request: AgentRequest) {
  if (request.kind !== 'approval' || request.options === undefined) return []
  const denyOptions = request.options.filter(option => option.kind === 'deny')
  return request.options.filter(option => {
    if (option.decision !== undefined) return true
    if (option.kind === 'allow' && option.scope !== 'session' && option.scope !== 'project') return true
    return option.kind === 'deny' && denyOptions.length === 1
  })
}

export function approvalDecision(
  request: AgentRequest,
  option: NonNullable<AgentRequest['options']>[number],
): AgentRequestDecision | null {
  if (!eligibleApprovalOptions(request).some(candidate => candidate.id === option.id)) return null
  if (option.decision !== undefined) return option.decision
  if (option.kind === 'allow' && option.scope !== 'session' && option.scope !== 'project') {
    return { kind: 'approve', optionId: option.id }
  }
  if (option.kind === 'deny') return { kind: 'deny' }
  return null
}

export function questionDecision(
  request: AgentRequest,
  answers: Readonly<Record<string, string | ReadonlyArray<string>>>,
): AgentRequestDecision | null {
  if (request.kind !== 'question' || request.questions.length === 0) return null
  const result: Record<string, string | string[]> = {}
  for (const question of request.questions) {
    const answer = validatedQuestionAnswer(question, answers[question.id])
    if (answer === null) return null
    result[question.id] = answer
  }
  return { kind: 'answers', answers: result }
}

export function validatedQuestionAnswer(
  question: AgentRequest['questions'][number],
  answer: string | readonly string[] | undefined,
): string | string[] | null {
  if (answer === undefined || Array.isArray(answer) !== question.multiSelect) return null
  const values = typeof answer === 'string' ? [answer] : [...answer]
  if (values.length === 0 || values.some(value => value.trim().length === 0)) return null
  if (new Set(values).size !== values.length) return null
  const customAllowed = question.options.length === 0 || question.allowCustomAnswer === true
  if (!customAllowed && values.some(value => !question.options.some(option => option.id === value))) return null
  return question.multiSelect ? values : (values[0] ?? null)
}

export function questionAnswerLabels(
  question: AgentRequest['questions'][number],
  decision: AgentRequestDecision | undefined,
): readonly string[] {
  if (decision?.kind !== 'answers') return []
  const answer = decision.answers[question.id]
  if (answer === undefined) return []
  if (question.isSecret) return ['Hidden answer']
  const values = typeof answer === 'string' ? [answer] : answer
  return values.map(value => question.options.find(option => option.id === value)?.label ?? value)
}
