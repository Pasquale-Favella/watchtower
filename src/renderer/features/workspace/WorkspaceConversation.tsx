import { useEffect, useRef, useState } from 'react'

import { Markdown } from '@/renderer/components/Markdown'
import {
  useWorkspaceConversation,
  useWorkspaceEvents,
  useWorkspacePayload,
} from '@/renderer/features/workspace/hooks.js'
import type { WorkspaceRequest } from '@/renderer/features/workspace/lib.js'
import type { ConversationId } from '@/shared/schemas/workspace.js'
import type { WorkspaceConversationPageItem, WorkspacePayloadReference } from '@/shared/schemas/workspace-store.js'

import {
  canonicalPayload,
  conversationPageHasMore,
  decodeConversationEvent,
  decodeConversationPayload,
  driverEventSummary,
  eventPayloadReference,
  eventSummary,
  mergeConversationItems,
  messagePayloadReference,
} from './conversation-view.js'

const PAGE_SIZE = 100
const VISIBLE_LIMIT = 300
const PAYLOAD_CHUNK_SIZE = 65_536

type ResolvedPayload = ReturnType<typeof decodeConversationPayload>
type Transcript = { readonly conversationId: ConversationId; readonly items: WorkspaceConversationPageItem[] }

const initialRequest = (conversationId: ConversationId): WorkspaceRequest<'workspace:readConversationPage'> => ({
  conversationId,
  afterSequence: 0,
  limit: PAGE_SIZE,
})

function referenceKey(reference: WorkspacePayloadReference): string {
  return `${reference.kind}:${reference.id}:${reference.digest}`
}

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

/** Read-only durable transcript for one Conversation. */
export function WorkspaceConversation({ conversationId }: { conversationId: ConversationId }): React.JSX.Element {
  return <WorkspaceConversationView key={conversationId} conversationId={conversationId} />
}

function WorkspaceConversationView({ conversationId }: { conversationId: ConversationId }): React.JSX.Element {
  const { projection, stream } = useWorkspaceEvents()
  const [transcript, setTranscript] = useState<Transcript>({ conversationId, items: [] })
  const [highWatermark, setHighWatermark] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [renderStart, setRenderStart] = useState<number | null>(null)
  const [activeRequest, setActiveRequest] = useState<WorkspaceRequest<'workspace:readConversationPage'> | null>(() =>
    initialRequest(conversationId),
  )
  const [processedRequest, setProcessedRequest] = useState<string | null>(null)
  const conversationRequest = activeRequest
  const conversation = useWorkspaceConversation(conversationRequest)
  const [activePayload, setActivePayload] = useState<{
    readonly reference: WorkspacePayloadReference
    readonly owner: string
  } | null>(null)
  const [payloadRequest, setPayloadRequest] = useState<WorkspaceRequest<'workspace:readWorkspacePayload'> | null>(null)
  const [payloadJson, setPayloadJson] = useState('')
  const [payloadProcessedRequest, setPayloadProcessedRequest] = useState<string | null>(null)
  const [payloadResult, setPayloadResult] = useState<{
    readonly key: string
    readonly owner: string
    readonly value: ResolvedPayload
    readonly error: string | null
  } | null>(null)
  const payloadIdentityRef = useRef<string | null>(null)
  const payload = useWorkspacePayload(payloadRequest)

  const requestKey = conversationRequest ? JSON.stringify(conversationRequest) : null
  useEffect(() => {
    if (!conversationRequest || !conversation.data || !requestKey || processedRequest === requestKey) return
    const page = conversation.data
    const pageHasMore = conversationPageHasMore(page)
    setTranscript(current => ({
      conversationId,
      items: mergeConversationItems(current.items, page.items),
    }))
    setHighWatermark(page.highWatermark)
    setHasMore(pageHasMore)
    setProcessedRequest(requestKey)
    if (!pageHasMore) setActiveRequest(null)
  }, [conversation.data, conversationRequest, conversationId, processedRequest, requestKey])

  // Once the fixed-watermark history has drained, catch up from the live stream watermark.
  useEffect(() => {
    if (activeRequest || hasMore) return
    if (projection.lastAppliedSequence <= highWatermark) return
    setProcessedRequest(null)
    setActiveRequest({
      conversationId,
      afterSequence: highWatermark,
      throughSequence: projection.lastAppliedSequence,
      limit: PAGE_SIZE,
    })
  }, [activeRequest, conversationId, hasMore, highWatermark, projection.lastAppliedSequence])

  const payloadRequestKey = payloadRequest ? JSON.stringify(payloadRequest) : null
  useEffect(() => {
    payloadIdentityRef.current = activePayload ? `${conversationId}|${referenceKey(activePayload.reference)}` : null
  }, [activePayload, conversationId])
  useEffect(() => {
    if (!payload.error || !activePayload || !payloadRequest) return
    setPayloadResult({
      key: referenceKey(activePayload.reference),
      owner: activePayload.owner,
      value: null,
      error: payload.error,
    })
    setPayloadRequest(null)
  }, [activePayload, payload.error, payloadRequest])

  useEffect(() => {
    if (
      !activePayload ||
      !payloadRequest ||
      !payload.data ||
      !payloadRequestKey ||
      payloadProcessedRequest === payloadRequestKey
    )
      return
    const owner = activePayload.owner
    const key = referenceKey(activePayload.reference)
    if (payload.data.total < 0 || payloadJson.length + payload.data.json.length > payload.data.total) {
      setPayloadResult({ key, owner, value: null, error: 'Payload length did not match its reference.' })
      setPayloadRequest(null)
      setPayloadProcessedRequest(payloadRequestKey)
      return
    }
    const assembled = payloadJson + payload.data.json
    setPayloadJson(assembled)
    setPayloadProcessedRequest(payloadRequestKey)
    if (payload.data.nextAfterOffset !== null) {
      setPayloadRequest({
        reference: activePayload.reference,
        afterOffset: payload.data.nextAfterOffset,
        limit: PAYLOAD_CHUNK_SIZE,
      })
      return
    }
    if (assembled.length !== payload.data.total) {
      setPayloadResult({ key, owner, value: null, error: 'Payload was incomplete.' })
      setPayloadRequest(null)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(assembled)
    } catch {
      setPayloadResult({ key, owner, value: null, error: 'Payload was not valid JSON.' })
      setPayloadRequest(null)
      return
    }
    void crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(canonicalPayload(parsed)))
      .then(digest => {
        if (payloadIdentityRef.current !== `${conversationId}|${key}`) return
        const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
        const digestMatches = actual === activePayload.reference.digest
        const value = digestMatches ? decodeConversationPayload(activePayload.reference, assembled) : null
        setPayloadResult({
          key,
          owner,
          value,
          error: !digestMatches
            ? 'Payload digest did not match its reference.'
            : value
              ? null
              : 'Payload type or identity did not match its reference.',
        })
        setPayloadRequest(null)
      })
      .catch(() => {
        if (payloadIdentityRef.current !== `${conversationId}|${key}`) return
        setPayloadResult({ key, owner, value: null, error: 'Unable to verify payload identity.' })
        setPayloadRequest(null)
      })
  }, [
    activePayload,
    conversationId,
    payload.data,
    payloadJson,
    payloadProcessedRequest,
    payloadRequest,
    payloadRequestKey,
  ])

  const items = transcript.items
  const start = renderStart ?? Math.max(0, items.length - VISIBLE_LIMIT)
  const shownItems = items.slice(start, start + VISIBLE_LIMIT)
  const loadPayload = (reference: WorkspacePayloadReference, owner: string) => {
    payloadIdentityRef.current = `${conversationId}|${referenceKey(reference)}`
    setActivePayload({ reference, owner })
    setPayloadJson('')
    setPayloadProcessedRequest(null)
    setPayloadResult(null)
    setPayloadRequest({ reference, afterOffset: 0, limit: PAYLOAD_CHUNK_SIZE })
  }

  if (conversation.status === 'loading' && processedRequest === null && items.length === 0) {
    return (
      <div className="text-muted-foreground p-5 text-sm" role="status">
        Loading conversation…
      </div>
    )
  }
  if (conversation.error && items.length === 0) {
    return (
      <div className="text-destructive p-5 text-sm" role="alert">
        {conversation.error}
      </div>
    )
  }

  return (
    <section className="flex min-h-0 flex-col" aria-label="Conversation history">
      {conversation.error && (
        <p className="text-destructive p-3 text-sm" role="alert">
          {conversation.error}
        </p>
      )}
      {stream.status === 'reconnecting' && (
        <p className="text-muted-foreground px-4 py-2 text-xs" role="status">
          Reconnecting to new conversation activity…
        </p>
      )}
      {items.length === 0 && processedRequest !== null ? (
        <p className="text-muted-foreground p-5 text-sm">No conversation activity yet.</p>
      ) : (
        <ol className="flex min-h-0 flex-col gap-3 overflow-y-auto p-4" aria-live="polite">
          {shownItems.map(item => {
            const event = item.event
            const decoded = decodeConversationEvent(event)
            const eventRef = eventPayloadReference(event)
            const fullEvent =
              payloadResult?.owner === `event:${event.sequence}` &&
              eventRef &&
              payloadResult.key === referenceKey(eventRef)
                ? payloadResult.value
                : null
            const displayEvent = fullEvent && 'data' in fullEvent ? fullEvent : null
            const driver = displayEvent ? decodeConversationEvent(displayEvent as typeof event) : decoded
            const messageRef = item.userMessage && messagePayloadReference(item.userMessage)
            const fullMessage =
              payloadResult?.owner === `message:${item.userMessage?.id}` &&
              payloadResult.key === (messageRef ? referenceKey(messageRef) : '')
                ? payloadResult.value
                : null
            let messageContent = item.userMessage?.content
            if (item.userMessage?.payloadTruncated) messageContent = undefined
            if (fullMessage && 'content' in fullMessage) messageContent = fullMessage.content
            return (
              <li key={event.sequence} className="space-y-2" aria-label={`Conversation event ${event.sequence}`}>
                {item.userMessage && (
                  <article className="bg-primary/10 ml-auto max-w-[85%] rounded-lg p-4" aria-label="User message">
                    <header className="text-muted-foreground mb-2 flex items-center justify-between gap-4 text-xs">
                      <strong>User</strong>
                      <time dateTime={item.userMessage.createdAt}>{formatTime(item.userMessage.createdAt)}</time>
                    </header>
                    {messageContent !== undefined ? (
                      <div className="typeset break-words">
                        <Markdown>{messageContent}</Markdown>
                      </div>
                    ) : null}
                    {messageRef && messageContent === undefined && (
                      <PayloadControl
                        reference={messageRef}
                        owner={`message:${item.userMessage.id}`}
                        active={activePayload}
                        result={payloadResult}
                        pending={Boolean(payloadRequest)}
                        onLoad={loadPayload}
                      />
                    )}
                    {item.userMessage.payloadTruncated && !messageRef && (
                      <p className="text-muted-foreground text-sm" role="status">
                        Full message unavailable: its payload reference is invalid.
                      </p>
                    )}
                  </article>
                )}
                <article className="bg-card max-w-[92%] rounded-lg border p-4">
                  <header className="text-muted-foreground mb-2 flex items-center justify-between gap-4 text-xs">
                    <strong className="text-foreground">
                      {driver ? driverEventSummary(driver) : eventSummary(event)}
                    </strong>
                    <time dateTime={event.occurredAt}>{formatTime(event.occurredAt)}</time>
                  </header>
                  {driver && <DriverContent event={driver} />}
                  {!driver && eventRef && (
                    <PayloadControl
                      reference={eventRef}
                      owner={`event:${event.sequence}`}
                      active={activePayload}
                      result={payloadResult}
                      pending={Boolean(payloadRequest)}
                      onLoad={loadPayload}
                    />
                  )}
                  {!driver && event.payloadTruncated && !eventRef && (
                    <p className="text-muted-foreground text-sm" role="status">
                      Full event detail unavailable: its payload reference is invalid.
                    </p>
                  )}
                  {!driver && !eventRef && <EventSummary event={event} />}
                  {payloadResult?.error && activePayload?.owner === `event:${event.sequence}` && (
                    <p role="alert" className="text-destructive mt-2 text-sm">
                      {payloadResult.error}
                    </p>
                  )}
                </article>
              </li>
            )
          })}
        </ol>
      )}
      <footer className="flex shrink-0 items-center justify-center gap-3 border-t p-3">
        {hasMore && (
          <button
            type="button"
            className="rounded-md border px-3 py-2 text-sm"
            onClick={() => {
              const next = conversation.nextRequest
              if (next) {
                setProcessedRequest(null)
                setActiveRequest(next)
              }
            }}
          >
            Load more history
          </button>
        )}
        {start > 0 && (
          <button
            type="button"
            className="rounded-md border px-3 py-2 text-sm"
            onClick={() => setRenderStart(Math.max(0, start - VISIBLE_LIMIT))}
          >
            Show earlier loaded activity
          </button>
        )}
        {renderStart !== null && start + VISIBLE_LIMIT < items.length && (
          <button
            type="button"
            className="rounded-md border px-3 py-2 text-sm"
            onClick={() => {
              const nextStart = start + VISIBLE_LIMIT
              setRenderStart(nextStart >= Math.max(0, items.length - VISIBLE_LIMIT) ? null : nextStart)
            }}
          >
            Show newer loaded activity
          </button>
        )}
        {activeRequest !== null && conversation.status === 'loading' && items.length > 0 && (
          <span className="text-muted-foreground text-xs" role="status">
            Loading history…
          </span>
        )}
      </footer>
    </section>
  )
}

function EventSummary({ event }: { readonly event: WorkspaceConversationPageItem['event'] }) {
  const reason = event.data.reason
  const ownerEpoch = event.data.ownerEpoch
  return (
    <div className="space-y-1 text-sm">
      <p>
        {eventSummary(event)} · Run <code>{event.runId}</code>
      </p>
      {typeof reason === 'string' && <p className="text-destructive break-words whitespace-pre-wrap">{reason}</p>}
      {typeof ownerEpoch === 'number' && <p className="text-muted-foreground">Owner epoch {ownerEpoch}</p>}
    </div>
  )
}

function PayloadControl({
  reference,
  owner,
  active,
  result,
  pending,
  onLoad,
}: {
  readonly reference: WorkspacePayloadReference
  readonly owner: string
  readonly active: { readonly reference: WorkspacePayloadReference; readonly owner: string } | null
  readonly result: {
    readonly key: string
    readonly owner: string
    readonly value: ResolvedPayload
    readonly error: string | null
  } | null
  readonly pending: boolean
  readonly onLoad: (reference: WorkspacePayloadReference, owner: string) => void
}) {
  const isActive = active?.owner === owner && referenceKey(active.reference) === referenceKey(reference)
  const resolved = result?.owner === owner && result.key === referenceKey(reference) ? result.value : null
  return (
    <div className="mt-2 space-y-2">
      {resolved && 'content' in resolved && (
        <div className="typeset break-words">
          <Markdown>{resolved.content}</Markdown>
        </div>
      )}
      {resolved && 'data' in resolved && (
        <DriverContent
          event={decodeConversationEvent(resolved) ?? { kind: 'nativeNotice', message: 'Unrecognized event detail.' }}
        />
      )}
      {result?.owner === owner && result.key === referenceKey(reference) && result.error && (
        <p role="alert" className="text-destructive text-sm">
          {result.error}
        </p>
      )}
      {!resolved && (
        <button
          type="button"
          className="rounded-md border px-3 py-1.5 text-sm"
          disabled={pending && isActive}
          onClick={() => onLoad(reference, owner)}
        >
          {pending && isActive ? 'Loading full content…' : 'Load full content'}
        </button>
      )}
    </div>
  )
}

function DriverContent({ event }: { readonly event: import('@/shared/schemas/execution.js').AgentDriverEvent }) {
  switch (event.kind) {
    case 'textDelta':
    case 'reasoningDelta':
      return (
        <div className="typeset break-words">
          <Markdown>{event.text}</Markdown>
        </div>
      )
    case 'toolStarted':
      return (
        <div className="space-y-1 text-sm">
          <p>
            Tool call <code>{event.toolCallId}</code>
          </p>
          {event.input && (
            <pre className="bg-muted max-h-80 overflow-auto rounded p-3 break-words whitespace-pre-wrap">
              {event.input}
            </pre>
          )}
          <p className="text-muted-foreground">Running</p>
        </div>
      )
    case 'toolUpdated':
      return (
        <div className="space-y-1 text-sm">
          <p>
            Tool call <code>{event.toolCallId}</code> · Updated
          </p>
          {event.output && (
            <pre className="bg-muted max-h-80 overflow-auto rounded p-3 break-words whitespace-pre-wrap">
              {event.output}
            </pre>
          )}
        </div>
      )
    case 'toolCompleted':
      return (
        <div className="space-y-1 text-sm">
          <p>
            Tool call <code>{event.toolCallId}</code> · {event.error ? 'Failed' : 'Completed'}
          </p>
          {event.error && <pre className="text-destructive break-words whitespace-pre-wrap">{event.error}</pre>}
        </div>
      )
    case 'turnFailed':
    case 'nativeNotice':
      return (
        <p
          className={
            event.kind === 'turnFailed'
              ? 'text-destructive text-sm break-words whitespace-pre-wrap'
              : 'text-sm break-words whitespace-pre-wrap'
          }
        >
          {event.message}
        </p>
      )
    case 'requestPending':
      return (
        <div className="space-y-2 text-sm">
          <p className="break-words whitespace-pre-wrap">{event.request.prompt}</p>
          {event.request.options?.map(option => (
            <p key={option.id} className="text-muted-foreground">
              {option.label}
            </p>
          ))}
        </div>
      )
    case 'requestResolved':
      return (
        <p className="text-sm">
          Request <code>{event.requestId}</code> resolved.
        </p>
      )
    case 'turnStarted':
    case 'turnCompleted':
    case 'turnInterrupted':
      return (
        <p className="text-sm">
          {driverEventSummary(event)}
          {event.nativeTurnId ? ` · ${event.nativeTurnId}` : ''}
        </p>
      )
    case 'usageReported':
      return (
        <p className="text-muted-foreground text-sm">
          Usage {event.inputTokens ?? 0} input / {event.outputTokens ?? 0} output tokens
        </p>
      )
  }
}
