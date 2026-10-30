import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { type AgentDriverEvent, agentDriverEventSchema } from '@/shared/schemas/execution.js'
import type { ConversationId } from '@/shared/schemas/workspace.js'
import {
  workspaceConversationMessageSchema,
  type WorkspaceConversationPageItem,
  type WorkspaceExecutionEvent,
  workspaceExecutionEventSchema,
  type WorkspacePayloadReference,
} from '@/shared/schemas/workspace-store.js'

import type { WorkspaceRequest } from './lib.js'

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

export type ConversationTurnBlock =
  | { readonly kind: 'text'; readonly text: string; readonly itemId: string | null; readonly sequence: number }
  | { readonly kind: 'thinking'; readonly text: string; readonly itemId: string | null; readonly sequence: number }
  | {
      readonly kind: 'tool'
      readonly toolCallId: string
      readonly name: string
      readonly input: string | null
      readonly output: string | null
      readonly error: string | null
      readonly status: 'running' | 'completed' | 'failed' | 'unknown'
      readonly continued: boolean
      readonly sequence: number
    }
  | {
      readonly kind: 'unavailable'
      readonly sequence: number
      readonly reference: WorkspacePayloadReference | null
    }
  | { readonly kind: 'request'; readonly event: AgentDriverEvent; readonly sequence: number }
  | { readonly kind: 'notice'; readonly event: AgentDriverEvent; readonly sequence: number }

export interface ConversationUserMessage {
  readonly kind: 'user'
  readonly id: string
  readonly sequence: number
  readonly message: NonNullable<WorkspaceConversationPageItem['userMessage']>
}

export interface ConversationAssistantTurn {
  readonly kind: 'assistant'
  readonly id: string
  readonly runId: WorkspaceExecutionEvent['runId']
  readonly generation: number
  readonly nativeTurnId: string | null
  readonly sequence: number
  readonly blocks: readonly ConversationTurnBlock[]
  readonly audit: readonly WorkspaceExecutionEvent[]
}

export interface ConversationStatusNotice {
  readonly kind: 'status'
  readonly id: string
  readonly sequence: number
  readonly event: WorkspaceExecutionEvent
}

export type ConversationEntry = ConversationUserMessage | ConversationAssistantTurn | ConversationStatusNotice
type MutableAssistantTurn = Omit<ConversationAssistantTurn, 'blocks' | 'audit'> & {
  readonly blocks: ConversationTurnBlock[]
  readonly audit: WorkspaceExecutionEvent[]
  readonly identityKey: string
}

/** Project ordered durable records into user messages and assistant turns. */
export function projectConversation(
  items: readonly WorkspaceConversationPageItem[],
  hydratedEvents: ReadonlyMap<number, WorkspaceExecutionEvent> = new Map(),
): ConversationEntry[] {
  const ordered = [...items].sort((a, b) => a.event.sequence - b.event.sequence)
  const entries: Array<ConversationUserMessage | ConversationStatusNotice | MutableAssistantTurn> = []
  const users = new Map<string, ConversationUserMessage>()
  const activeNativeTurns = new Map<string, string>()
  const toolStates = new Map<string, Extract<ConversationTurnBlock, { readonly kind: 'tool' }>>()
  let lastTurn: MutableAssistantTurn | null = null

  for (const item of ordered) {
    const { event } = item
    if (item.userMessage && !users.has(item.userMessage.id)) {
      const user: ConversationUserMessage = {
        kind: 'user',
        id: `message:${item.userMessage.id}`,
        sequence: event.sequence,
        message: item.userMessage,
      }
      users.set(item.userMessage.id, user)
      entries.push(user)
      lastTurn = null
    }

    if (isConversationStatusEvent(event)) {
      entries.push({ kind: 'status', id: `status:${event.sequence}`, sequence: event.sequence, event })
      lastTurn = null
      continue
    }
    if (event.kind !== 'driverEvent') continue
    const hydratedEvent = hydratedEvents.get(event.sequence)
    const driver = decodeConversationEvent(hydratedEvent ?? event)
    if (!driver && !event.payloadTruncated) continue
    const runGeneration = `${event.runId}:${event.generation}`
    if (driver && 'nativeTurnId' in driver && driver.nativeTurnId)
      activeNativeTurns.set(runGeneration, driver.nativeTurnId)
    const nativeTurnId =
      (driver && 'nativeTurnId' in driver ? driver.nativeTurnId : undefined) ??
      activeNativeTurns.get(runGeneration) ??
      null
    const identityKey = `${event.runId}:${event.generation}:${nativeTurnId ?? 'unidentified'}`
    let turn: MutableAssistantTurn | null = lastTurn?.identityKey === identityKey ? lastTurn : null
    if (!turn) {
      turn = {
        kind: 'assistant',
        id: `turn:${event.runId}:${event.generation}:${event.sequence}`,
        identityKey,
        runId: event.runId,
        generation: event.generation,
        nativeTurnId,
        sequence: event.sequence,
        blocks: [],
        audit: [],
      }
      entries.push(turn)
      lastTurn = turn
    }
    if (driver) {
      appendTurnBlock(turn.blocks, driver, event.sequence, toolStates, identityKey)
    } else {
      turn.blocks.push({
        kind: 'unavailable',
        sequence: event.sequence,
        reference: eventPayloadReference(event),
      })
    }
    turn.audit.push(event)
  }

  return entries.map(entry => {
    if (entry.kind !== 'assistant') return entry
    return {
      kind: entry.kind,
      id: entry.id,
      runId: entry.runId,
      generation: entry.generation,
      nativeTurnId: entry.nativeTurnId,
      sequence: entry.sequence,
      blocks: [...entry.blocks],
      audit: [...entry.audit],
    }
  })
}

function isConversationStatusEvent(event: WorkspaceExecutionEvent): boolean {
  return (
    event.kind === 'runQueued' ||
    event.kind === 'dispatchClaimed' ||
    event.kind === 'runStarted' ||
    event.kind === 'runFailed' ||
    event.kind === 'runUncertain' ||
    event.kind === 'runRecoveryRequired' ||
    event.kind === 'runInterruptRequested'
  )
}

function appendTurnBlock(
  blocks: ConversationTurnBlock[],
  event: AgentDriverEvent,
  sequence: number,
  toolStates: Map<string, Extract<ConversationTurnBlock, { readonly kind: 'tool' }>>,
  identityKey: string,
): void {
  const previous = blocks.at(-1)
  if (event.kind === 'textDelta' || event.kind === 'reasoningDelta') {
    const kind = event.kind === 'textDelta' ? 'text' : 'thinking'
    if (previous?.kind === kind && previous.itemId === (event.itemId ?? null)) {
      blocks[blocks.length - 1] = { ...previous, text: previous.text + event.text }
      return
    }
    blocks.push({ kind, text: event.text, itemId: event.itemId ?? null, sequence })
    return
  }
  if (event.kind === 'toolStarted' || event.kind === 'toolUpdated' || event.kind === 'toolCompleted') {
    const localPrior = blocks.find(
      (block): block is Extract<ConversationTurnBlock, { readonly kind: 'tool' }> =>
        block.kind === 'tool' && block.toolCallId === event.toolCallId,
    )
    const prior = localPrior ?? toolStates.get(`${identityKey}:${event.toolCallId}`)
    const index = localPrior ? blocks.indexOf(localPrior) : -1
    const continued = localPrior?.continued ?? (!localPrior && prior !== undefined)
    const tool: ConversationTurnBlock & { readonly kind: 'tool' } = {
      kind: 'tool',
      toolCallId: event.toolCallId,
      name: event.kind === 'toolStarted' ? event.name : (prior?.name ?? 'Tool'),
      input: event.kind === 'toolStarted' ? (event.input ?? null) : (prior?.input ?? null),
      output: event.kind === 'toolUpdated' && event.output !== undefined ? event.output : (prior?.output ?? null),
      error: event.kind === 'toolCompleted' ? (event.error ?? null) : (prior?.error ?? null),
      status:
        event.kind === 'toolCompleted'
          ? event.error
            ? 'failed'
            : 'completed'
          : event.kind === 'toolStarted'
            ? 'running'
            : (prior?.status ?? 'unknown'),
      continued,
      sequence: localPrior?.sequence ?? sequence,
    }
    if (index < 0) blocks.push(tool)
    else blocks[index] = tool
    toolStates.set(`${identityKey}:${event.toolCallId}`, tool)
    return
  }
  if (event.kind === 'requestPending' || event.kind === 'requestResolved') {
    blocks.push({ kind: 'request', event, sequence })
    return
  }
  if (event.kind === 'nativeNotice' || event.kind === 'turnFailed') {
    blocks.push({ kind: 'notice', event, sequence })
  }
}

/** Start live tail catch-up independently of whether older history remains. */
export function conversationCatchupRequest(
  conversationId: ConversationId,
  historyWatermark: number,
  liveWatermark: number,
  requestInFlight: boolean,
  limit: number,
): WorkspaceRequest<'workspace:readConversationPage'> | null {
  if (requestInFlight || liveWatermark <= historyWatermark) return null
  return {
    conversationId,
    afterSequence: historyWatermark,
    throughSequence: liveWatermark,
    limit,
  }
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
