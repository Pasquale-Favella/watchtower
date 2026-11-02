import { useMemo, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import type { AgentRequest, AgentRequestDecision } from '@/shared/schemas/execution.js'
import type { ConversationId, TaskId } from '@/shared/schemas/workspace.js'
import type { WorkspacePendingRuntimeRequest } from '@/shared/schemas/workspace-store.js'

import {
  useRespondToRuntimeRequest,
  useWorkspacePendingRequests,
  useWorkspaceRequestResponses,
  useWorkspaceTaskSnapshot,
  type WorkspaceRequest,
  type WorkspaceResult,
} from './hooks.js'
import {
  approvalDecision,
  eligibleApprovalOptions,
  questionDecision,
  requestIsCurrent,
  requestResponseState,
  type ResponseDeliveryState,
} from './request-controls.js'

const PAGE_SIZE = 50
const snapshotRequest = (taskId: TaskId): WorkspaceRequest<'workspace:readTaskSnapshot'> => ({
  taskId,
  runLimit: 100,
})
const firstPendingRequest = (taskId: TaskId): WorkspaceRequest<'workspace:listPendingRuntimeRequests'> => ({
  taskId,
  afterSequence: 0,
  limit: PAGE_SIZE,
})
const firstResponseRequest = (taskId: TaskId): WorkspaceRequest<'workspace:listRequestResponses'> => ({
  taskId,
  options: { limit: PAGE_SIZE },
})

type PendingRequest = WorkspacePendingRuntimeRequest
type ResponseItem = WorkspaceResult<'workspace:listRequestResponses'>['items'][number]
type SnapshotResponseItem = NonNullable<WorkspaceResult<'workspace:readTaskSnapshot'>['requestResponses']>[number]
type ResponseRecord = ResponseItem | SnapshotResponseItem

const requestKey = (request: Pick<PendingRequest['request'], 'requestId' | 'runId' | 'generation'>) =>
  `${request.runId}:${request.generation}:${request.requestId}`

/** Approval and question controls scoped to one Task and Conversation. */
export function WorkspaceRequests({
  taskId,
  conversationId,
}: {
  readonly taskId: TaskId
  readonly conversationId: ConversationId
}): React.JSX.Element {
  return <WorkspaceRequestsView key={`${taskId}:${conversationId}`} taskId={taskId} conversationId={conversationId} />
}

function WorkspaceRequestsView({
  taskId,
  conversationId,
}: {
  readonly taskId: TaskId
  readonly conversationId: ConversationId
}): React.JSX.Element | null {
  const [pendingRequest, setPendingRequest] = useState(() => firstPendingRequest(taskId))
  const [responseRequest, setResponseRequest] = useState(() => firstResponseRequest(taskId))
  const [earlierPending, setEarlierPending] = useState<PendingRequest[]>([])
  const [earlierResponses, setEarlierResponses] = useState<ResponseItem[]>([])
  const snapshotQuery = useWorkspaceTaskSnapshot(snapshotRequest(taskId))
  const pendingQuery = useWorkspacePendingRequests(pendingRequest)
  const responseQuery = useWorkspaceRequestResponses(responseRequest)
  const respond = useRespondToRuntimeRequest()
  const [localDelivery, setLocalDelivery] = useState<Record<string, ResponseDeliveryState>>({})

  const snapshot = snapshotQuery.data
  const runContexts = snapshot?.runContexts ?? []
  const pendingItems = useMemo(() => {
    const byIdentity = new Map<string, PendingRequest>()
    for (const item of [...earlierPending, ...(pendingQuery.data?.items ?? [])]) {
      if (item.taskId === taskId) byIdentity.set(requestKey(item.request), item)
    }
    return [...byIdentity.values()]
  }, [earlierPending, pendingQuery.data?.items, taskId])
  const visibleRequests = pendingItems.filter(
    item =>
      runContexts.some(context => context.runId === item.runId && context.conversationId === conversationId) ||
      !runContexts.some(context => context.runId === item.runId),
  )
  const responses = useMemo(() => {
    const byCommand = new Map<string, ResponseRecord>()
    for (const response of [
      ...(snapshot?.requestResponses ?? []),
      ...earlierResponses,
      ...(responseQuery.data?.items ?? []),
    ]) {
      byCommand.set(response.commandId, response)
    }
    return [...byCommand.values()]
  }, [earlierResponses, responseQuery.data?.items, snapshot?.requestResponses])
  const responseTruncated = Boolean(snapshot?.requestResponseSummary?.truncated || responseQuery.data?.truncated)
  const runCoverageTruncated = Boolean(snapshot?.runCoverage?.truncated)
  const requestHistoryTruncated = Boolean(pendingQuery.data?.hasMore)
  const responseHistoryHasMore = responseQuery.data?.nextAfterPosition !== null
  const visibleResponses = responses.filter(response =>
    runContexts.some(context => context.runId === response.runId && context.conversationId === conversationId),
  )

  const sendResponse = async (item: PendingRequest, decision: AgentRequestDecision) => {
    const key = requestKey(item.request)
    setLocalDelivery(current => ({ ...current, [key]: 'pending' }))
    try {
      await respond.execute({
        commandId: crypto.randomUUID(),
        runId: item.runId,
        generation: item.request.generation,
        requestId: item.request.requestId,
        decision,
      })
      setLocalDelivery(current => ({ ...current, [key]: 'pending' }))
    } catch {
      setLocalDelivery(current => ({ ...current, [key]: 'uncertain' }))
    }
  }

  const showOlderRequests = () => {
    const nextAfterSequence = pendingQuery.data?.nextAfterSequence
    if (nextAfterSequence === null || nextAfterSequence === undefined) return
    setEarlierPending(current => [...current, ...(pendingQuery.data?.items ?? [])])
    setPendingRequest({ taskId, afterSequence: nextAfterSequence, limit: PAGE_SIZE })
  }
  const showOlderResponses = () => {
    const nextAfterPosition = responseQuery.data?.nextAfterPosition
    if (nextAfterPosition === null || nextAfterPosition === undefined) return
    setEarlierResponses(current => [...current, ...(responseQuery.data?.items ?? [])])
    setResponseRequest({ taskId, options: { afterPosition: nextAfterPosition, limit: PAGE_SIZE } })
  }

  if (snapshotQuery.error || pendingQuery.error || responseQuery.error) {
    return (
      <section className="border-t px-4 py-3" aria-label="Approvals and questions">
        <p role="alert" className="text-destructive text-sm">
          Could not load request state. Responses are unavailable until the authoritative reads succeed.
        </p>
        {snapshotQuery.error && <p className="text-muted-foreground mt-1 text-xs">Task snapshot read failed.</p>}
        {pendingQuery.error && <p className="text-muted-foreground mt-1 text-xs">Pending request read failed.</p>}
        {responseQuery.error && <p className="text-muted-foreground mt-1 text-xs">Response history read failed.</p>}
      </section>
    )
  }

  if (!snapshot || !pendingQuery.data || !responseQuery.data) {
    return (
      <section className="border-t px-4 py-2" aria-label="Approvals and questions" aria-busy="true">
        <p role="status" className="text-muted-foreground text-xs">
          Loading approval and question state…
        </p>
      </section>
    )
  }

  if (
    visibleRequests.length === 0 &&
    visibleResponses.length === 0 &&
    !requestHistoryTruncated &&
    !responseHistoryHasMore &&
    !responseTruncated
  ) {
    return null
  }

  return (
    <section className="max-h-[35vh] shrink-0 overflow-y-auto border-t px-4 py-3" aria-label="Approvals and questions">
      <div className="space-y-3">
        {visibleRequests.map(item => {
          const isCurrent = requestIsCurrent(item, conversationId, snapshot.runs, runContexts)
          const historyState = requestResponseState(
            [...earlierResponses, ...(responseQuery.data?.items ?? [])],
            item.runId,
            item.request.generation,
            item.request.requestId,
          )
          const snapshotState = snapshot.requestResponses?.find(
            response =>
              response.runId === item.runId &&
              response.generation === item.request.generation &&
              response.requestId === item.request.requestId,
          )?.state
          const delivery =
            (historyState && historyState !== 'resolved' ? historyState : null) ??
            (snapshotState && snapshotState !== 'resolved' ? snapshotState : null) ??
            localDelivery[requestKey(item.request)]
          return (
            <RequestCard
              key={requestKey(item.request)}
              item={item}
              current={isCurrent}
              delivery={delivery ?? null}
              onRespond={decision => void sendResponse(item, decision)}
            />
          )
        })}
        {visibleResponses
          .filter(response => ['pending', 'failed', 'uncertain'].includes(response.state))
          .map(response => (
            <ResponseHistory key={response.commandId} response={response} />
          ))}
        {visibleResponses.some(response => ['accepted', 'resolved'].includes(response.state)) && (
          <details className="text-muted-foreground text-xs">
            <summary className="cursor-pointer">Previous decisions</summary>
            <div className="mt-2 space-y-2">
              {visibleResponses
                .filter(response => ['accepted', 'resolved'].includes(response.state))
                .map(response => (
                  <ResponseHistory key={response.commandId} response={response} />
                ))}
            </div>
          </details>
        )}

        {(runCoverageTruncated || responseTruncated || requestHistoryTruncated) && (
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" role="status">
            <span>
              {runCoverageTruncated && 'Run context is incomplete; requests without context are shown disabled. '}
              {responseTruncated && 'Response history is truncated. '}
              {requestHistoryTruncated && 'More pending request history is available.'}
            </span>
            {requestHistoryTruncated && (
              <Button type="button" size="sm" variant="outline" onClick={showOlderRequests}>
                Load more pending requests
              </Button>
            )}
            {responseHistoryHasMore && (
              <Button type="button" size="sm" variant="outline" onClick={showOlderResponses}>
                Load more response history
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}

function RequestCard({
  item,
  current,
  delivery,
  onRespond,
}: {
  readonly item: PendingRequest
  readonly current: boolean
  readonly delivery: ResponseDeliveryState | null
  readonly onRespond: (decision: AgentRequestDecision) => void
}): React.JSX.Element {
  const request = item.request
  return (
    <article className={`rounded-lg border p-3 ${current ? 'bg-background' : 'bg-muted/40 opacity-80'}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{request.kind === 'approval' ? 'Approval requested' : 'Question'}</h2>
          <details className="text-muted-foreground mt-1 text-xs">
            <summary className="cursor-pointer">Request details</summary>
            <p className="mt-1 break-all">
              Run {item.runId} · generation {request.generation}
            </p>
          </details>
        </div>
        {delivery && <DeliveryStatus state={delivery} />}
      </header>
      <p className="mt-2 text-sm break-words whitespace-pre-wrap">{request.prompt}</p>
      {!current && (
        <p className="text-muted-foreground mt-2 text-xs" role="status">
          This request belongs to an inactive or stale Run. It cannot be answered from this view.
        </p>
      )}
      {request.kind === 'approval' ? (
        <ApprovalControls request={request} disabled={!current || delivery !== null} onRespond={onRespond} />
      ) : (
        <QuestionControls request={request} disabled={!current || delivery !== null} onRespond={onRespond} />
      )}
    </article>
  )
}

function ApprovalControls({
  request,
  disabled,
  onRespond,
}: {
  readonly request: AgentRequest
  readonly disabled: boolean
  readonly onRespond: (decision: AgentRequestDecision) => void
}): React.JSX.Element {
  const options = request.options ?? []
  const eligible = eligibleApprovalOptions(request)
  return (
    <div className="mt-3 space-y-2">
      <details>
        <summary className="text-muted-foreground cursor-pointer text-xs">Tool, path and scope details</summary>
        <pre className="bg-muted mt-2 max-h-48 overflow-auto rounded p-2 text-xs break-words whitespace-pre-wrap">
          {request.prompt}
        </pre>
      </details>
      {options.length > 0 ? (
        <div className="flex flex-wrap gap-2" aria-label="Native approval options">
          {options.map(option => {
            const decision = approvalDecision(request, option)
            const canChoose = eligible.some(candidate => candidate.id === option.id) && decision !== null
            return (
              <div key={option.id} className="flex flex-col items-start gap-1">
                <Button
                  type="button"
                  variant={option.kind === 'allow' ? 'default' : 'outline'}
                  disabled={disabled || !canChoose}
                  onClick={() => decision && onRespond(decision)}
                >
                  {option.label}
                </Button>
                <span className="text-muted-foreground text-[10px]">
                  {[option.scope, option.kind].filter(Boolean).join(' · ') || 'Native option'}
                </span>
                {!canChoose && (
                  <span className="text-muted-foreground text-[10px]">Response semantics unavailable</span>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">No native approval options were included with this request.</p>
      )}
    </div>
  )
}

function QuestionControls({
  request,
  disabled,
  onRespond,
}: {
  readonly request: AgentRequest
  readonly disabled: boolean
  readonly onRespond: (decision: AgentRequestDecision) => void
}): React.JSX.Element {
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({})
  const decision = questionDecision(request, answers)
  return (
    <div className="mt-3 space-y-3">
      {request.cancelDecision && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => request.cancelDecision && onRespond(request.cancelDecision)}
        >
          Cancel question
        </Button>
      )}
      {request.questions.map(question => {
        const selected = answers[question.id]
        const selectedValues = Array.isArray(selected) ? selected : selected ? [selected] : []
        return (
          <fieldset key={question.id} disabled={disabled} className="space-y-2">
            <legend className="text-sm font-medium">{question.prompt}</legend>
            {question.options.length === 0 ? (
              <label className="block space-y-1 text-xs">
                <span className="text-muted-foreground">Your answer</span>
                <input
                  className="bg-background w-full rounded-md border px-3 py-2 text-sm"
                  type="text"
                  value={typeof selected === 'string' ? selected : ''}
                  onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))}
                  autoComplete="off"
                />
              </label>
            ) : (
              question.options.map(option => {
                const checked = selectedValues.includes(option.id)
                return (
                  <label key={option.id} className="flex items-start gap-2 text-sm">
                    <input
                      type={question.multiSelect ? 'checkbox' : 'radio'}
                      name={question.id}
                      checked={checked}
                      onChange={() => {
                        setAnswers(current => {
                          const value = current[question.id]
                          if (question.multiSelect) {
                            const values = Array.isArray(value) ? value : []
                            return {
                              ...current,
                              [question.id]: checked ? values.filter(id => id !== option.id) : [...values, option.id],
                            }
                          }
                          return { ...current, [question.id]: option.id }
                        })
                      }}
                    />
                    <span>{option.label}</span>
                  </label>
                )
              })
            )}
          </fieldset>
        )
      })}
      <Button type="button" disabled={disabled || decision === null} onClick={() => decision && onRespond(decision)}>
        Submit answers
      </Button>
    </div>
  )
}

function DeliveryStatus({ state }: { readonly state: ResponseDeliveryState }): React.JSX.Element {
  const label = {
    pending: 'Response pending',
    accepted: 'Response accepted',
    failed: 'Response failed',
    uncertain: 'Response delivery uncertain',
  }[state]
  return (
    <span className="text-muted-foreground rounded-full border px-2 py-1 text-[10px]" role="status">
      {label}
    </span>
  )
}

function ResponseHistory({ response }: { readonly response: ResponseRecord }): React.JSX.Element {
  const state: ResponseDeliveryState = response.state === 'resolved' ? 'accepted' : response.state
  return (
    <div className="bg-muted/40 rounded border px-3 py-2 text-xs">
      <p>
        Request response · Run <code>{response.runId}</code> · generation {response.generation}
      </p>
      <DeliveryStatus state={state} />
      {response.state === 'resolved' && <p className="mt-1">The request was later resolved.</p>}
    </div>
  )
}
