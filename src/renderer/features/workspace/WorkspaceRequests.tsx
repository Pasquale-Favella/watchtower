import { ChevronDown, CircleAlert, MessageCircleQuestion, ShieldQuestion, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'

import { Button } from '@/renderer/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/renderer/components/ui/dropdown-menu'
import { TextTooltip } from '@/renderer/components/ui/tooltip'
import { cn } from '@/renderer/shared/lib/utils'
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
import { requestIsCurrent, requestLabel, requestResponseState, type ResponseDeliveryState } from './request-controls.js'
import {
  approvalActions,
  firstPendingRequest,
  orderRequestsForDrawer,
  PENDING_REQUEST_PAGE_SIZE,
} from './request-drawer-state.js'
import { RequestToolDetails } from './request-tool-details.js'
import { QuestionForm } from './requests/QuestionForm.js'

const PAGE_SIZE = PENDING_REQUEST_PAGE_SIZE

const snapshotRequest = (taskId: TaskId): WorkspaceRequest<'workspace:readTaskSnapshot'> => ({
  taskId,
  runLimit: 100,
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

function approvalScopeLabel(scope: NonNullable<AgentRequest['options']>[number]['scope']): string {
  switch (scope) {
    case 'once':
      return 'One request only'
    case 'session':
      return 'For this session'
    case 'project':
      return 'For this project'
    default:
      return 'Scope set by agent'
  }
}

/**
 * Approval and question controls for one Task and Conversation, docked on top of the composer.
 * One request is answerable at a time: the oldest current one. Later requests wait their turn.
 */
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
  const responding = useRef(new Set<string>())

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
    if (responding.current.has(key)) return
    responding.current.add(key)
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
    } finally {
      responding.current.delete(key)
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
      <Drawer>
        <p role="alert" className="text-destructive text-sm">
          Could not load request state. Responses are unavailable until the authoritative reads succeed.
        </p>
        {snapshotQuery.error && <p className="text-muted-foreground mt-1 text-xs">Task snapshot read failed.</p>}
        {pendingQuery.error && <p className="text-muted-foreground mt-1 text-xs">Pending request read failed.</p>}
        {responseQuery.error && <p className="text-muted-foreground mt-1 text-xs">Response history read failed.</p>}
      </Drawer>
    )
  }

  // Nothing is shown until the authoritative reads land, so the composer does not jump on every load.
  if (!snapshot || !pendingQuery.data || !responseQuery.data) return null

  const unsettledResponses = visibleResponses.filter(response =>
    ['pending', 'failed', 'uncertain'].includes(response.state),
  )
  if (
    visibleRequests.length === 0 &&
    unsettledResponses.length === 0 &&
    !requestHistoryTruncated &&
    !responseHistoryHasMore &&
    !responseTruncated
  ) {
    return null
  }

  const deliveryFor = (item: PendingRequest): ResponseDeliveryState | null => {
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
    return (
      (historyState && historyState !== 'resolved' ? historyState : null) ??
      (snapshotState && snapshotState !== 'resolved' ? snapshotState : null) ??
      localDelivery[requestKey(item.request)] ??
      null
    )
  }
  const { active, waiting, stale } = orderRequestsForDrawer(visibleRequests, item =>
    requestIsCurrent(item, conversationId, snapshot.runs, runContexts),
  )
  // Responses for the request in the drawer are shown on it, not repeated below.
  const answeredElsewhere = unsettledResponses.filter(
    response =>
      !active ||
      response.runId !== active.runId ||
      response.generation !== active.request.generation ||
      response.requestId !== active.request.requestId,
  )

  return (
    <Drawer>
      {active && (
        <RequestPanel
          key={requestKey(active.request)}
          item={active}
          waitingCount={waiting.length}
          delivery={deliveryFor(active)}
          onRespond={decision => void sendResponse(active, decision)}
        />
      )}
      {stale.length > 0 && <StaleRequests items={stale} />}
      {answeredElsewhere.map(response => (
        <ResponseHistory key={response.commandId} response={response} />
      ))}
      {(runCoverageTruncated || responseTruncated || requestHistoryTruncated || responseHistoryHasMore) && (
        <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" role="status">
          <span>
            {runCoverageTruncated && 'Run context is incomplete; requests without context cannot be answered. '}
            {responseTruncated && 'Response history is truncated. '}
            {requestHistoryTruncated && 'More pending request history is available.'}
          </span>
          {requestHistoryTruncated && (
            <Button type="button" size="xs" variant="outline" onClick={showOlderRequests}>
              Load more pending requests
            </Button>
          )}
          {responseHistoryHasMore && (
            <Button type="button" size="xs" variant="outline" onClick={showOlderResponses}>
              Load more response history
            </Button>
          )}
        </div>
      )}
    </Drawer>
  )
}

/** Sits on top of the prompt card, which overlaps its bottom edge so the two read as one surface. */
function Drawer({ children }: { readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <section aria-label="Approvals and questions" className="-mb-4 px-3">
      <div className="bg-muted/60 max-h-[45vh] overflow-y-auto rounded-t-2xl border border-b-0 px-4 pt-3 pb-6">
        {children}
      </div>
    </section>
  )
}

function RequestPanel({
  item,
  waitingCount,
  delivery,
  onRespond,
}: {
  readonly item: PendingRequest
  readonly waitingCount: number
  readonly delivery: ResponseDeliveryState | null
  readonly onRespond: (decision: AgentRequestDecision) => void
}): React.JSX.Element {
  const request = item.request
  const disabled = delivery !== null
  return (
    <article aria-label={request.kind === 'approval' ? 'Approval request' : 'Question'} className="space-y-3">
      {request.kind === 'approval' ? (
        <ApprovalPanel
          request={request}
          waitingCount={waitingCount}
          delivery={delivery}
          disabled={disabled}
          onRespond={onRespond}
        />
      ) : (
        <QuestionPanel
          request={request}
          waitingCount={waitingCount}
          delivery={delivery}
          disabled={disabled}
          onRespond={onRespond}
        />
      )}
      <details className="text-muted-foreground text-[10px]">
        <summary className="focus-visible:ring-ring w-fit cursor-pointer rounded-sm focus-visible:ring-2 focus-visible:outline-none">
          Request identity
        </summary>
        <p className="mt-1 break-all">
          Run {item.runId} · generation {request.generation}
        </p>
      </details>
    </article>
  )
}

function PanelHeader({
  icon,
  title,
  waitingCount,
  delivery,
  children,
}: {
  readonly icon: React.ReactNode
  readonly title: React.ReactNode
  readonly waitingCount: number
  readonly delivery: ResponseDeliveryState | null
  readonly children?: React.ReactNode
}): React.JSX.Element {
  return (
    <header className="flex min-w-0 items-center gap-2">
      <span className="text-warning shrink-0">{icon}</span>
      <h2 className="min-w-0 truncate text-xs font-semibold">{title}</h2>
      <span className="ml-auto flex shrink-0 items-center gap-2">
        {waitingCount > 0 && (
          <span className="text-muted-foreground text-[10px]" role="status">
            +{waitingCount} waiting
          </span>
        )}
        {delivery && <DeliveryStatus state={delivery} />}
        {children}
      </span>
    </header>
  )
}

function ApprovalPanel({
  request,
  waitingCount,
  delivery,
  disabled,
  onRespond,
}: {
  readonly request: AgentRequest
  readonly waitingCount: number
  readonly delivery: ResponseDeliveryState | null
  readonly disabled: boolean
  readonly onRespond: (decision: AgentRequestDecision) => void
}): React.JSX.Element {
  const actions = approvalActions(request)
  const hasActions = actions.approve !== null || actions.decline !== null || actions.more.length > 0
  const expandablePrompt = request.prompt.length > 180 || request.prompt.includes('\n')
  return (
    <>
      <PanelHeader
        icon={<ShieldQuestion className="size-3.5" />}
        title={requestLabel(request)}
        waitingCount={waitingCount}
        delivery={delivery}
      />
      <div>
        <p className={cn('text-sm break-words whitespace-pre-wrap', expandablePrompt && 'line-clamp-3')}>
          {request.prompt}
        </p>
        {expandablePrompt && (
          <details className="mt-1 text-xs">
            <summary className="focus-visible:ring-ring w-fit cursor-pointer rounded-sm focus-visible:ring-2 focus-visible:outline-none">
              Read full request
            </summary>
            <p className="mt-2 max-h-40 overflow-y-auto break-words whitespace-pre-wrap">{request.prompt}</p>
          </details>
        )}
      </div>
      <RequestToolDetails request={request} />
      {hasActions ? (
        <div className="flex flex-wrap items-center justify-end gap-2" aria-label="Approval options">
          {actions.unavailable.length > 0 && (
            <details className="text-muted-foreground mr-auto text-[10px]">
              <summary className="cursor-pointer">
                {actions.unavailable.length} option{actions.unavailable.length === 1 ? '' : 's'} cannot be sent safely
              </summary>
              <ul className="mt-1 space-y-1">
                {actions.unavailable.map(option => (
                  <li key={option.id} className="max-w-64 break-words">
                    <span className="font-medium">{option.label}</span>
                    <span className="block">Watchtower cannot represent this native response exactly.</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {actions.more.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button type="button" size="sm" variant="ghost" disabled={disabled}>
                    More options
                    <ChevronDown className="size-3" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-auto">
                {actions.more.map(action => (
                  <DropdownMenuItem
                    key={action.option.id}
                    aria-label={action.option.label}
                    aria-description={approvalScopeLabel(action.option.scope)}
                    disabled={disabled}
                    onClick={() => onRespond(action.decision)}
                  >
                    <span className="flex w-full flex-col gap-0.5">
                      <span>{action.option.label}</span>
                      <span className="text-muted-foreground text-[10px]">
                        {approvalScopeLabel(action.option.scope)}
                      </span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {actions.decline && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => actions.decline && onRespond(actions.decline.decision)}
            >
              {actions.decline.option.label}
            </Button>
          )}
          {actions.approve && (
            <Button
              aria-label={actions.approve.option.label}
              aria-description={approvalScopeLabel(actions.approve.option.scope)}
              type="button"
              size="sm"
              disabled={disabled}
              onClick={() => actions.approve && onRespond(actions.approve.decision)}
            >
              {actions.approve.option.label}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          This request has no options that can be answered from Watchtower. Stop the Run to release it.
        </p>
      )}
    </>
  )
}

function QuestionPanel({
  request,
  waitingCount,
  delivery,
  disabled,
  onRespond,
}: {
  readonly request: AgentRequest
  readonly waitingCount: number
  readonly delivery: ResponseDeliveryState | null
  readonly disabled: boolean
  readonly onRespond: (decision: AgentRequestDecision) => void
}): React.JSX.Element {
  return (
    <>
      <PanelHeader
        icon={<MessageCircleQuestion className="size-3.5" />}
        title={requestLabel(request)}
        waitingCount={waitingCount}
        delivery={delivery}
      >
        {request.cancelDecision && (
          <TextTooltip
            label="Dismiss question without answering"
            trigger={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Dismiss question without answering"
                disabled={disabled}
                onClick={() => request.cancelDecision && onRespond(request.cancelDecision)}
              >
                <X className="size-3" />
              </Button>
            }
          />
        )}
      </PanelHeader>
      <QuestionForm request={request} disabled={disabled} delivery={delivery} onRespond={onRespond} />
    </>
  )
}

function StaleRequests({ items }: { readonly items: readonly PendingRequest[] }): React.JSX.Element {
  return (
    <details className="text-muted-foreground mt-2 text-xs">
      <summary className="cursor-pointer">
        {items.length} request{items.length === 1 ? '' : 's'} from an inactive Run
      </summary>
      <p className="mt-1">These belong to a stale or settled Run and cannot be answered from this view.</p>
      <ul className="mt-1 space-y-1">
        {items.map(item => (
          <TextTooltip
            key={requestKey(item.request)}
            label={item.request.prompt}
            trigger={
              <li className="truncate">
                {item.request.kind === 'approval' ? 'Approval' : 'Question'} · {item.request.prompt}
              </li>
            }
          />
        ))}
      </ul>
    </details>
  )
}

function DeliveryStatus({ state }: { readonly state: ResponseDeliveryState }): React.JSX.Element {
  const label = {
    pending: 'Sending response…',
    accepted: 'Response accepted',
    failed: 'Response failed',
    uncertain: 'Response delivery uncertain',
  }[state]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px]',
        state === 'failed' || state === 'uncertain' ? 'text-destructive' : 'text-muted-foreground',
      )}
      role="status"
    >
      {(state === 'failed' || state === 'uncertain') && <CircleAlert className="size-3" />}
      {label}
    </span>
  )
}

function ResponseHistory({ response }: { readonly response: ResponseRecord }): React.JSX.Element {
  const state: ResponseDeliveryState = response.state === 'resolved' ? 'accepted' : response.state
  return (
    <div className="text-muted-foreground mt-2 flex flex-wrap items-center gap-2 text-xs">
      <span>Earlier response</span>
      <DeliveryStatus state={state} />
      <details>
        <summary className="cursor-pointer">Details</summary>
        <p className="break-all">
          Run <code>{response.runId}</code> · generation {response.generation}
        </p>
      </details>
    </div>
  )
}
