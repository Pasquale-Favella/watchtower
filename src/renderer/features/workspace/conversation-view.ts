import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { type AgentDriverEvent, agentDriverEventSchema } from '@/shared/schemas/execution.js'
import {
  workspaceConversationMessageSchema,
  type WorkspaceConversationPage,
  type WorkspaceConversationPageItem,
  type WorkspaceExecutionEvent,
  workspaceExecutionEventSchema,
  type WorkspacePayloadReference,
} from '@/shared/schemas/workspace-store.js'

/** Merge durable pages by event sequence, keeping the earliest user-message association. */
export function mergeConversationItems(
  current: readonly WorkspaceConversationPageItem[],
  incoming: readonly WorkspaceConversationPageItem[],
): WorkspaceConversationPageItem[] {
  const bySequence = new Map(current.map(item => [item.event.sequence, item]))
  for (const item of incoming) {
    const prior = bySequence.get(item.event.sequence)
    bySequence.set(item.event.sequence, prior?.userMessage ? prior : item)
  }
  return [...bySequence.values()].sort((a, b) => a.event.sequence - b.event.sequence)
}

export function conversationPageHasMore(page: WorkspaceConversationPage): boolean {
  return page.hasMore && page.nextAfterSequence !== null
}

export function decodeConversationEvent(event: WorkspaceExecutionEvent): AgentDriverEvent | null {
  if (event.payloadTruncated) return null
  const data = Schema.decodeUnknownOption(Schema.Struct({ event: agentDriverEventSchema }))(event.data)
  return Option.isSome(data) ? data.value.event : null
}

export function decodeConversationPayload(
  reference: WorkspacePayloadReference,
  json: string,
): WorkspaceConversationPageItem['event'] | WorkspaceConversationPageItem['userMessage'] | null {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return null
  }
  if (reference.kind === 'event') {
    const decoded = Schema.decodeUnknownOption(workspaceExecutionEventSchema)(value)
    return Option.isSome(decoded) && String(decoded.value.sequence) === reference.id ? decoded.value : null
  }
  if (reference.kind === 'message') {
    const decoded = Schema.decodeUnknownOption(workspaceConversationMessageSchema)(value)
    return Option.isSome(decoded) && decoded.value.id === reference.id ? decoded.value : null
  }
  return null
}

export function eventPayloadReference(event: WorkspaceExecutionEvent): WorkspacePayloadReference | null {
  return event.payloadTruncated && event.payloadRef?.kind === 'event' ? event.payloadRef : null
}

export function messagePayloadReference(message: NonNullable<WorkspaceConversationPageItem['userMessage']>) {
  return message.payloadTruncated && message.payloadRef?.kind === 'message' ? message.payloadRef : null
}

export function eventSummary(event: WorkspaceExecutionEvent): string {
  switch (event.kind) {
    case 'runQueued':
      return 'Run queued'
    case 'dispatchClaimed':
      return 'Starting agent'
    case 'runStarted':
      return 'Run started'
    case 'runUncertain':
      return 'Delivery status uncertain'
    case 'runRecoveryRequired':
      return 'Recovery required'
    case 'runFailed':
      return 'Run failed'
    case 'runInterruptRequested':
      return 'Interruption requested'
    case 'requestResponseRecorded':
      return 'Response recorded'
    case 'requestResponseSettled':
      return 'Response delivery updated'
    case 'steerRecorded':
      return 'Follow-up recorded'
    case 'steerSettled':
      return 'Follow-up delivery updated'
    case 'driverEvent':
      return 'Agent activity'
  }
}

export function driverEventSummary(event: AgentDriverEvent): string {
  switch (event.kind) {
    case 'turnStarted':
      return 'Turn started'
    case 'turnCompleted':
      return 'Turn completed'
    case 'turnInterrupted':
      return 'Turn interrupted'
    case 'turnFailed':
      return 'Turn failed'
    case 'textDelta':
      return 'Assistant'
    case 'reasoningDelta':
      return 'Reasoning'
    case 'toolStarted':
      return `Tool started: ${event.name}`
    case 'toolUpdated':
      return 'Tool output'
    case 'toolCompleted':
      return event.error ? 'Tool failed' : 'Tool completed'
    case 'requestPending':
      return event.request.kind === 'approval' ? 'Approval requested' : 'Question requested'
    case 'requestResolved':
      return 'Request resolved'
    case 'usageReported':
      return 'Usage reported'
    case 'nativeNotice':
      return 'Agent notice'
  }
}

export function canonicalPayload(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalPayload).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalPayload(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}
