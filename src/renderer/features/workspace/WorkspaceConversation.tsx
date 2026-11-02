import { useCallback, useEffect, useRef, useState } from 'react'

import { Markdown } from '@/renderer/components/Markdown'
import { Button } from '@/renderer/components/ui/button'
import { MessageScrollerItem } from '@/renderer/components/ui/message-scroller'
import {
  useWorkspaceConversation,
  useWorkspaceEvents,
  useWorkspacePayload,
} from '@/renderer/features/workspace/hooks.js'
import type { WorkspaceRequest } from '@/renderer/features/workspace/lib.js'
import type { ConversationId } from '@/shared/schemas/workspace.js'
import type {
  WorkspaceConversationPageItem,
  WorkspaceExecutionEvent,
  WorkspacePayloadReference,
} from '@/shared/schemas/workspace-store.js'

import {
  canonicalPayload,
  type ConversationAssistantTurn,
  conversationCatchupRequest,
  type ConversationStatusNotice,
  type ConversationTurnBlock,
  type ConversationUserMessage,
  decodeConversationEvent,
  decodeConversationPayload,
  driverEventSummary,
  eventPayloadReference,
  eventSummary,
  isActiveRunStatus,
  mergeConversationItems,
  messagePayloadReference,
  projectConversationView,
} from './conversation-view.js'
import {
  createPayloadCache,
  MAX_DISPLAY_PAYLOAD_BYTES,
  type PayloadCache,
  payloadExceedsDisplayLimit,
  readPayload,
  rememberPayload,
  wasPayloadReleased,
} from './payload-cache.js'
import { ActivityRow } from './timeline/ActivityRow.js'
import { readExpandedFolds, setFoldExpanded } from './timeline/conversation-memory.js'
import { ExpandableMessage } from './timeline/ExpandableMessage.js'
import { isCollapsibleMessage } from './timeline/message-collapse.js'
import { formatMessageTime } from './timeline/message-time.js'
import { MessageActions } from './timeline/MessageActions.js'
import { TimelineScroller } from './timeline/TimelineScroller.js'
import { buildTurnSegments, isEmptySettledTurn, turnCopyText } from './timeline/turn-segments.js'
import { TurnFoldRow, WorkGroupRow } from './timeline/WorkLog.js'

const PAGE_SIZE = 100
const AUDIT_PAGE_SIZE = 300
const PAYLOAD_CHUNK_SIZE = 65_536

type ResolvedPayload = ReturnType<typeof decodeConversationPayload>
type PayloadResult = {
  readonly key: string
  readonly owner: string
  readonly value: ResolvedPayload
  readonly error: string | null
}
type Transcript = { readonly conversationId: ConversationId; readonly items: WorkspaceConversationPageItem[] }

function rememberPayloadResult(
  setResults: React.Dispatch<React.SetStateAction<PayloadCache<PayloadResult>>>,
  result: PayloadResult,
  bytes: number,
): void {
  const cacheKey = payloadCacheKey(result.owner, result.key)
  setResults(current => rememberPayload(current, cacheKey, result, bytes, cacheKey))
}

const initialRequest = (conversationId: ConversationId): WorkspaceRequest<'workspace:readConversationPage'> => ({
  conversationId,
  afterSequence: 0,
  direction: 'backward',
  limit: PAGE_SIZE,
})

function referenceKey(reference: WorkspacePayloadReference): string {
  return `${reference.kind}:${reference.id}:${reference.digest}`
}

function payloadCacheKey(owner: string, key: string): string {
  return `${owner}|${key}`
}

/** Read-only durable transcript for one Conversation. */
export function WorkspaceConversation({ conversationId }: { conversationId: ConversationId }): React.JSX.Element {
  return <WorkspaceConversationView key={conversationId} conversationId={conversationId} />
}

function WorkspaceConversationView({ conversationId }: { conversationId: ConversationId }): React.JSX.Element {
  const { projection, stream } = useWorkspaceEvents()
  const [transcript, setTranscript] = useState<Transcript>({ conversationId, items: [] })
  const [highWatermark, setHighWatermark] = useState(0)
  const [hasOlderHistory, setHasOlderHistory] = useState(false)
  const [olderRequest, setOlderRequest] = useState<WorkspaceRequest<'workspace:readConversationPage'> | null>(null)
  const [auditStart, setAuditStart] = useState<number | null>(null)
  const [activeRequest, setActiveRequest] = useState<WorkspaceRequest<'workspace:readConversationPage'> | null>(() =>
    initialRequest(conversationId),
  )
  const [processedRequest, setProcessedRequest] = useState<string | null>(null)
  const [expandedFolds, setExpandedFolds] = useState<ReadonlySet<string>>(() => readExpandedFolds(conversationId))
  const conversationRequest = activeRequest
  const conversation = useWorkspaceConversation(conversationRequest)
  const [activePayload, setActivePayload] = useState<{
    readonly reference: WorkspacePayloadReference
    readonly owner: string
  } | null>(null)
  const [payloadRequest, setPayloadRequest] = useState<WorkspaceRequest<'workspace:readWorkspacePayload'> | null>(null)
  const [payloadJson, setPayloadJson] = useState('')
  const [payloadByteLength, setPayloadByteLength] = useState(0)
  const [payloadProcessedRequest, setPayloadProcessedRequest] = useState<string | null>(null)
  const [payloadResults, setPayloadResults] = useState<PayloadCache<PayloadResult>>(() => createPayloadCache())
  const payloadIdentityRef = useRef<string | null>(null)
  const payload = useWorkspacePayload(payloadRequest)

  const requestKey = conversationRequest ? JSON.stringify(conversationRequest) : null
  useEffect(() => {
    if (!conversationRequest || !conversation.data || !requestKey || processedRequest === requestKey) return
    const page = conversation.data
    const nextRequest = conversation.nextRequest
    setTranscript(current => ({
      conversationId,
      items: mergeConversationItems(current.items, page.items),
    }))
    setProcessedRequest(requestKey)
    if (conversationRequest.direction === 'backward') {
      if (conversationRequest.beforeSequence === undefined) setHighWatermark(page.highWatermark)
      setOlderRequest(nextRequest)
      setHasOlderHistory(nextRequest !== null)
      setActiveRequest(null)
    } else {
      setHighWatermark(conversationRequest.throughSequence ?? page.highWatermark)
      setActiveRequest(nextRequest)
    }
  }, [conversation.data, conversation.nextRequest, conversationRequest, conversationId, processedRequest, requestKey])

  // Once the fixed-watermark history has drained, catch up from the live stream watermark.
  useEffect(() => {
    const request = conversationCatchupRequest(
      conversationId,
      highWatermark,
      projection.lastAppliedSequence,
      activeRequest !== null,
      PAGE_SIZE,
    )
    if (!request) return
    setProcessedRequest(null)
    setActiveRequest(request)
  }, [activeRequest, conversationId, highWatermark, projection.lastAppliedSequence])

  const payloadRequestKey = payloadRequest ? JSON.stringify(payloadRequest) : null
  useEffect(() => {
    payloadIdentityRef.current = activePayload ? `${conversationId}|${referenceKey(activePayload.reference)}` : null
  }, [activePayload, conversationId])
  useEffect(() => {
    if (!payload.error || !activePayload || !payloadRequest) return
    rememberPayloadResult(
      setPayloadResults,
      {
        key: referenceKey(activePayload.reference),
        owner: activePayload.owner,
        value: null,
        error: payload.error,
      },
      0,
    )
    setPayloadRequest(null)
    setPayloadJson('')
    setPayloadByteLength(0)
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
    const chunkBytes = new TextEncoder().encode(payload.data.json).byteLength
    if (payloadExceedsDisplayLimit(payloadByteLength, chunkBytes, payload.data.total, MAX_DISPLAY_PAYLOAD_BYTES)) {
      rememberPayloadResult(
        setPayloadResults,
        { key, owner, value: null, error: 'Full content exceeds the 8 MiB individual display limit.' },
        0,
      )
      setPayloadRequest(null)
      setPayloadProcessedRequest(payloadRequestKey)
      setPayloadJson('')
      setPayloadByteLength(0)
      return
    }
    if (payload.data.total < 0 || payloadJson.length + payload.data.json.length > payload.data.total) {
      rememberPayloadResult(
        setPayloadResults,
        {
          key,
          owner,
          value: null,
          error: 'Payload length did not match its reference.',
        },
        0,
      )
      setPayloadRequest(null)
      setPayloadProcessedRequest(payloadRequestKey)
      setPayloadJson('')
      setPayloadByteLength(0)
      return
    }
    const assembled = payloadJson + payload.data.json
    setPayloadJson(assembled)
    const assembledBytes = payloadByteLength + chunkBytes
    setPayloadByteLength(assembledBytes)
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
      rememberPayloadResult(setPayloadResults, { key, owner, value: null, error: 'Payload was incomplete.' }, 0)
      setPayloadRequest(null)
      setPayloadJson('')
      setPayloadByteLength(0)
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(assembled)
    } catch {
      rememberPayloadResult(setPayloadResults, { key, owner, value: null, error: 'Payload was not valid JSON.' }, 0)
      setPayloadRequest(null)
      setPayloadJson('')
      setPayloadByteLength(0)
      return
    }
    void crypto.subtle
      .digest('SHA-256', new TextEncoder().encode(canonicalPayload(parsed)))
      .then(digest => {
        if (payloadIdentityRef.current !== `${conversationId}|${key}`) return
        const actual = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
        const digestMatches = actual === activePayload.reference.digest
        const value = digestMatches ? decodeConversationPayload(activePayload.reference, assembled) : null
        rememberPayloadResult(
          setPayloadResults,
          {
            key,
            owner,
            value,
            error: !digestMatches
              ? 'Payload digest did not match its reference.'
              : value
                ? null
                : 'Payload type or identity did not match its reference.',
          },
          value === null ? 0 : assembledBytes,
        )
        setPayloadRequest(null)
        setPayloadJson('')
        setPayloadByteLength(0)
      })
      .catch(() => {
        if (payloadIdentityRef.current !== `${conversationId}|${key}`) return
        rememberPayloadResult(
          setPayloadResults,
          {
            key,
            owner,
            value: null,
            error: 'Unable to verify payload identity.',
          },
          0,
        )
        setPayloadRequest(null)
        setPayloadJson('')
        setPayloadByteLength(0)
      })
  }, [
    activePayload,
    conversationId,
    payload.data,
    payloadJson,
    payloadByteLength,
    payloadProcessedRequest,
    payloadRequest,
    payloadRequestKey,
  ])

  const items = transcript.items
  const hydratedEvents = new Map<number, WorkspaceExecutionEvent>()
  for (const { value: result } of payloadResults.entries.values()) {
    if (result.value && 'data' in result.value) hydratedEvents.set(result.value.sequence, result.value)
  }
  const { entries: projected, activity } = projectConversationView(items, hydratedEvents)
  const entries = projected.filter(
    entry => entry.kind !== 'status' || !['runQueued', 'dispatchClaimed', 'runStarted'].includes(entry.event.kind),
  )
  // Rendering follows the loaded pages. Older pages prepend, and the timeline keeps the reader's anchor.
  const auditOffset = auditStart ?? Math.max(0, items.length - AUDIT_PAGE_SIZE)
  const shownAuditItems = items.slice(auditOffset, auditOffset + AUDIT_PAGE_SIZE)
  const loadPayload = (reference: WorkspacePayloadReference, owner: string) => {
    payloadIdentityRef.current = `${conversationId}|${referenceKey(reference)}`
    setActivePayload({ reference, owner })
    setPayloadJson('')
    setPayloadByteLength(0)
    setPayloadProcessedRequest(null)
    setPayloadRequest({ reference, afterOffset: 0, limit: PAYLOAD_CHUNK_SIZE })
  }

  const toggleFold = useCallback(
    (key: string, open: boolean) => {
      setExpandedFolds(current => {
        const next = new Set(current)
        if (open) next.add(key)
        else next.delete(key)
        return next
      })
      setFoldExpanded(conversationId, key, open)
    },
    [conversationId],
  )

  const getPayloadResult = (owner: string, reference: WorkspacePayloadReference): PayloadResult | null =>
    readPayload(payloadResults, payloadCacheKey(owner, referenceKey(reference)))

  const wasPayloadPreviouslyReleased = (owner: string, reference: WorkspacePayloadReference): boolean =>
    wasPayloadReleased(payloadResults, payloadCacheKey(owner, referenceKey(reference)))

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

  const showsOlderControl = hasOlderHistory && olderRequest !== null
  const loadingOlder = activeRequest !== null && conversation.status === 'loading' && items.length > 0

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
      {(showsOlderControl || loadingOlder) && (
        <div className="flex shrink-0 flex-wrap items-center justify-center gap-3 border-b px-4 py-2">
          {showsOlderControl && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setProcessedRequest(null)
                setActiveRequest(olderRequest)
              }}
            >
              Load older messages
            </Button>
          )}
          {loadingOlder && (
            <span className="text-muted-foreground text-xs" role="status">
              Loading history…
            </span>
          )}
        </div>
      )}
      {items.length === 0 && processedRequest !== null ? (
        <p className="text-muted-foreground p-5 text-sm">Send a message to start the conversation.</p>
      ) : (
        <TimelineScroller conversationId={conversationId} restoreKey={entries.length}>
          {entries.map(entry => {
            if (entry.kind === 'user') {
              const reference = messagePayloadReference(entry.message)
              return (
                <MessageScrollerItem key={entry.id} messageId={entry.id} scrollAnchor>
                  <UserMessageEntry
                    entry={entry}
                    activePayload={activePayload}
                    payloadResult={reference ? getPayloadResult(`message:${entry.message.id}`, reference) : null}
                    released={
                      reference ? wasPayloadPreviouslyReleased(`message:${entry.message.id}`, reference) : false
                    }
                    payloadPending={Boolean(payloadRequest)}
                    onLoadPayload={loadPayload}
                  />
                </MessageScrollerItem>
              )
            }
            if (entry.kind === 'assistant') {
              return (
                <MessageScrollerItem key={entry.id} messageId={entry.id}>
                  <AssistantTurnEntry
                    entry={entry}
                    activePayload={activePayload}
                    payloadResults={payloadResults}
                    payloadPending={Boolean(payloadRequest)}
                    onLoadPayload={loadPayload}
                    expandedFolds={expandedFolds}
                    onFoldOpenChange={toggleFold}
                  />
                </MessageScrollerItem>
              )
            }
            return (
              <MessageScrollerItem key={entry.id} messageId={entry.id}>
                <ConversationStatusEntry entry={entry} />
              </MessageScrollerItem>
            )
          })}
          {activity && (
            <MessageScrollerItem messageId={`activity:${activity.runId}:${activity.generation}`}>
              <ActivityRow activity={activity} />
            </MessageScrollerItem>
          )}
        </TimelineScroller>
      )}
      <details className="border-t px-4 py-2">
        <summary className="text-muted-foreground cursor-pointer text-xs">
          Execution audit · {items.length} durable events
        </summary>
        <ol className="mt-2 max-h-80 space-y-2 overflow-auto">
          {shownAuditItems.map(item => {
            const reference = eventPayloadReference(item.event)
            return (
              <AuditEvent
                key={item.event.sequence}
                item={item}
                activePayload={activePayload}
                payloadResult={reference ? getPayloadResult(`event:${item.event.sequence}`, reference) : null}
                released={reference ? wasPayloadPreviouslyReleased(`event:${item.event.sequence}`, reference) : false}
                payloadPending={Boolean(payloadRequest)}
                onLoadPayload={loadPayload}
                hydratedEvent={hydratedEvents.get(item.event.sequence) ?? null}
              />
            )
          })}
        </ol>
        <div className="mt-2 flex gap-2">
          {auditOffset > 0 && (
            <button
              type="button"
              className="rounded-md border px-2 py-1"
              onClick={() => setAuditStart(Math.max(0, auditOffset - AUDIT_PAGE_SIZE))}
            >
              Earlier audit events
            </button>
          )}
          {auditStart !== null && auditOffset + AUDIT_PAGE_SIZE < items.length && (
            <button
              type="button"
              className="rounded-md border px-2 py-1"
              onClick={() => {
                const nextOffset = auditOffset + AUDIT_PAGE_SIZE
                setAuditStart(nextOffset >= Math.max(0, items.length - AUDIT_PAGE_SIZE) ? null : nextOffset)
              }}
            >
              Newer audit events
            </button>
          )}
        </div>
      </details>
    </section>
  )
}

function EventSummary({ event }: { readonly event: WorkspaceConversationPageItem['event'] }) {
  const reason = event.data.reason
  const ownerEpoch = event.data.ownerEpoch
  const replacedEpoch = event.data.replacedEpoch
  return (
    <div className="space-y-1 text-sm">
      <p>
        {eventSummary(event)} · Run <code>{event.runId}</code>
      </p>
      {typeof reason === 'string' && <p className="text-destructive break-words whitespace-pre-wrap">{reason}</p>}
      {typeof ownerEpoch === 'number' && <p className="text-muted-foreground">Owner epoch {ownerEpoch}</p>}
      {typeof replacedEpoch === 'number' && (
        <p className="text-muted-foreground">Recovered after owner epoch {replacedEpoch} was replaced</p>
      )}
    </div>
  )
}

interface PayloadProps {
  readonly activePayload: { readonly reference: WorkspacePayloadReference; readonly owner: string } | null
  readonly payloadResult: {
    readonly key: string
    readonly owner: string
    readonly value: ResolvedPayload
    readonly error: string | null
  } | null
  readonly released: boolean
  readonly payloadPending: boolean
  readonly onLoadPayload: (reference: WorkspacePayloadReference, owner: string) => void
}

function UserMessageEntry({
  entry,
  activePayload,
  payloadResult,
  released,
  payloadPending,
  onLoadPayload,
}: PayloadProps & {
  readonly entry: ConversationUserMessage
}): React.JSX.Element {
  const message = entry.message
  const reference = messagePayloadReference(message)
  const fullMessage =
    payloadResult?.owner === `message:${message.id}` && reference && payloadResult.key === referenceKey(reference)
      ? payloadResult.value
      : null
  let content: string | undefined = message.content
  if (message.payloadTruncated) {
    content = fullMessage && 'content' in fullMessage ? fullMessage.content : undefined
  }
  return (
    <article
      className="group/message bg-primary/10 ml-auto max-w-[85%] space-y-2 rounded-lg p-4"
      aria-label="User message"
    >
      {content !== undefined && (
        <ExpandableMessage expandable={isCollapsibleMessage(content)}>
          <div className="typeset break-words">
            <Markdown>{content}</Markdown>
          </div>
        </ExpandableMessage>
      )}
      {message.attachments && message.attachments.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label="Message attachments">
          {message.attachments.map(attachment => (
            <li
              key={attachment.id}
              className="bg-background/60 max-w-full truncate rounded-md border px-2 py-1 text-xs"
              title={attachment.name}
            >
              {attachment.source === 'skill' || attachment.source === 'command' ? '/' : ''}
              {attachment.name}
            </li>
          ))}
        </ul>
      )}
      {reference && content === undefined && (
        <PayloadControl
          reference={reference}
          owner={`message:${message.id}`}
          active={activePayload}
          result={payloadResult}
          released={released}
          pending={payloadPending}
          onLoad={onLoadPayload}
        />
      )}
      {message.payloadTruncated && !reference && (
        <p className="text-muted-foreground text-sm" role="status">
          Full message unavailable: its payload reference is invalid.
        </p>
      )}
      <MessageActions
        className="justify-end"
        copyText={content ? content : null}
        copyLabel="Copy message"
        timestamp={message.createdAt}
      />
    </article>
  )
}

interface HydratedTurnProps {
  readonly activePayload: { readonly reference: WorkspacePayloadReference; readonly owner: string } | null
  readonly payloadResults: PayloadCache<PayloadResult>
  readonly payloadPending: boolean
  readonly onLoadPayload: (reference: WorkspacePayloadReference, owner: string) => void
}

function AssistantTurnEntry({
  entry,
  activePayload,
  payloadResults,
  payloadPending,
  onLoadPayload,
  expandedFolds,
  onFoldOpenChange,
}: HydratedTurnProps & {
  readonly entry: ConversationAssistantTurn
  readonly expandedFolds: ReadonlySet<string>
  readonly onFoldOpenChange: (key: string, open: boolean) => void
}): React.JSX.Element {
  const segments = buildTurnSegments(entry)
  const streaming = isActiveRunStatus(entry.run.status)
  const copyText = streaming ? '' : turnCopyText(entry)
  return (
    <article className="group/message max-w-[92%] space-y-3 px-1 py-1" aria-label="Assistant turn">
      {segments.map(segment => {
        if (segment.kind === 'work') return <WorkGroupRow key={segment.key} group={segment} />
        if (segment.kind === 'fold') {
          return (
            <TurnFoldRow
              key={segment.key}
              label={segment.label}
              summary={segment.summary}
              groups={segment.groups}
              open={expandedFolds.has(segment.key)}
              onOpenChange={open => {
                onFoldOpenChange(segment.key, open)
              }}
            />
          )
        }
        return (
          <TurnBlock
            key={segment.key}
            block={segment.block}
            activePayload={activePayload}
            payloadResults={payloadResults}
            payloadPending={payloadPending}
            onLoadPayload={onLoadPayload}
          />
        )
      })}
      {isEmptySettledTurn(entry) && <p className="text-muted-foreground text-sm italic">(empty response)</p>}
      <span className="sr-only">Durable event sequences {entry.audit.map(event => event.sequence).join(', ')}</span>
      <MessageActions copyText={copyText ? copyText : null} copyLabel="Copy response" timestamp={entry.occurredAt}>
        <details className="min-w-0">
          <summary className="cursor-pointer">Turn details</summary>
          <p className="mt-1 break-all">
            Run {entry.runId} · generation {entry.generation}
          </p>
          {entry.nativeTurnId && <p className="break-all">Native turn {entry.nativeTurnId}</p>}
        </details>
      </MessageActions>
    </article>
  )
}

function TurnBlock({
  block,
  activePayload,
  payloadResults,
  payloadPending,
  onLoadPayload,
}: HydratedTurnProps & {
  readonly block: Exclude<ConversationTurnBlock, { readonly kind: 'tool' }>
}): React.JSX.Element {
  switch (block.kind) {
    case 'text':
      return (
        <div className="typeset break-words">
          <Markdown>{block.text}</Markdown>
        </div>
      )
    case 'thinking':
      return (
        <details className="text-muted-foreground rounded border px-3 py-2 text-sm">
          <summary className="cursor-pointer">Thinking</summary>
          <div className="typeset mt-2 break-words">
            <Markdown>{block.text}</Markdown>
          </div>
        </details>
      )
    case 'unavailable': {
      const owner = `event:${block.sequence}`
      const result = block.reference
        ? readPayload(payloadResults, payloadCacheKey(owner, referenceKey(block.reference)))
        : null
      const released = block.reference
        ? wasPayloadReleased(payloadResults, payloadCacheKey(owner, referenceKey(block.reference)))
        : false
      return (
        <div className="rounded border p-3 text-sm">
          <p className="text-muted-foreground">Assistant event #{block.sequence} has truncated content.</p>
          {block.reference ? (
            <PayloadControl
              reference={block.reference}
              owner={owner}
              active={activePayload}
              result={result}
              released={released}
              pending={payloadPending}
              onLoad={onLoadPayload}
            />
          ) : (
            <p className="text-muted-foreground mt-2" role="status">
              Full assistant event detail unavailable: its payload reference is invalid.
            </p>
          )}
        </div>
      )
    }
    case 'request':
      return (
        <div className="rounded border p-3 text-sm">
          <DriverContent event={block.event} />
        </div>
      )
    case 'notice':
      return <DriverContent event={block.event} />
  }
}

function ConversationStatusEntry({ entry }: { readonly entry: ConversationStatusNotice }): React.JSX.Element {
  const attention = ['runFailed', 'runUncertain', 'runRecoveryRequired'].includes(entry.event.kind)
  return (
    <article
      className={`max-w-[92%] rounded border px-3 py-2 text-sm ${attention ? 'border-destructive/50 bg-destructive/5' : 'bg-muted/40'}`}
      aria-label="Run status"
    >
      <p>{eventSummary(entry.event)}</p>
      {typeof entry.event.data.reason === 'string' && (
        <p className="text-destructive mt-1">{entry.event.data.reason}</p>
      )}
    </article>
  )
}

function AuditEvent({
  item,
  activePayload,
  payloadResult,
  payloadPending,
  onLoadPayload,
  hydratedEvent,
  released,
}: PayloadProps & {
  readonly item: WorkspaceConversationPageItem
  readonly hydratedEvent: WorkspaceExecutionEvent | null
}): React.JSX.Element {
  const event = item.event
  const reference = eventPayloadReference(event)
  const resolved =
    payloadResult?.owner === `event:${event.sequence}` && reference && payloadResult.key === referenceKey(reference)
      ? payloadResult.value
      : null
  const fullEvent = hydratedEvent ?? (resolved && 'data' in resolved ? resolved : null)
  const driver = fullEvent ? decodeConversationEvent(fullEvent) : decodeConversationEvent(event)
  return (
    <li className="rounded border px-3 py-2 text-xs">
      <p>
        <strong>
          #{event.sequence} · {driver ? driverEventSummary(driver) : eventSummary(event)}
        </strong>{' '}
        · Run <code>{event.runId}</code> · generation {event.generation} · {formatMessageTime(event.occurredAt)}
      </p>
      {driver && <DriverContent event={driver} />}
      {reference && !driver && (
        <PayloadControl
          reference={reference}
          owner={`event:${event.sequence}`}
          active={activePayload}
          result={payloadResult}
          released={released}
          pending={payloadPending}
          onLoad={onLoadPayload}
        />
      )}
      {event.payloadTruncated && !reference && (
        <p className="text-muted-foreground mt-2" role="status">
          Full event detail unavailable: its payload reference is invalid.
        </p>
      )}
      {!driver && !reference && <EventSummary event={event} />}
      {payloadResult?.owner === `event:${event.sequence}` && payloadResult.error && (
        <p role="alert" className="text-destructive mt-2">
          {payloadResult.error}
        </p>
      )}
    </li>
  )
}

function PayloadControl({
  reference,
  owner,
  active,
  result,
  pending,
  onLoad,
  released = false,
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
  readonly released?: boolean
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
      {!resolved && released && (
        <p className="text-muted-foreground text-sm" role="status">
          Previously loaded content was released to stay within the per-Conversation cache. Reload it to view again.
        </p>
      )}
      {!resolved && (
        <button
          type="button"
          className="rounded-md border px-3 py-1.5 text-sm"
          disabled={pending && isActive}
          onClick={() => onLoad(reference, owner)}
        >
          {pending && isActive
            ? 'Loading full content…'
            : released
              ? 'Reload full content'
              : result?.error
                ? 'Retry loading full content'
                : 'Load full content'}
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
      return null
    case 'capabilitiesUpdated':
      return <p className="text-muted-foreground text-sm">Agent controls updated.</p>
    case 'turnCompleted':
    case 'turnInterrupted':
      return <p className="text-sm">{driverEventSummary(event)}</p>
    case 'usageReported':
      return (
        <p className="text-muted-foreground text-sm">
          Usage {event.inputTokens ?? 0} input / {event.outputTokens ?? 0} output tokens
        </p>
      )
  }
}
