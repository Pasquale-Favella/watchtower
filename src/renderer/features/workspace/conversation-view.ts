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
  /** Occurrence of the turn's first durable record, shown as its timestamp. */
  readonly occurredAt: string
  /** Run facts as of the last loaded record for this Run and generation. */
  readonly run: ConversationRun
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

export type ConversationRunStatus =
  | 'queued'
  | 'starting'
  | 'active'
  | 'awaitingInput'
  | 'interrupting'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'uncertain'
  | 'recoveryRequired'

export interface ConversationRun {
  readonly runId: WorkspaceExecutionEvent['runId']
  readonly generation: number
  readonly status: ConversationRunStatus
  /** Occurrence of runStarted (or dispatchClaimed); null when that record is not loaded. */
  readonly startedAt: string | null
  /** Occurrence of the first loaded record for the Run, the fallback clock for live elapsed time. */
  readonly observedAt: string | null
  /** Occurrence of the record that settled the Run, when loaded. */
  readonly settledAt: string | null
  readonly pendingRequestKind: 'approval' | 'question' | null
  readonly lastOutput: 'reasoning' | 'text' | 'tool' | null
}

/** The live state of the most recent Run, when it has not settled. */
export interface ConversationActivity {
  readonly runId: WorkspaceExecutionEvent['runId']
  readonly generation: number
  readonly label: 'working' | 'thinking' | 'awaitingAnswer' | 'awaitingApproval'
  /** Start used for the elapsed ticker. */
  readonly since: string | null
}

export interface ConversationProjection {
  readonly entries: ConversationEntry[]
  readonly activity: ConversationActivity | null
}

const terminalRunStatuses = new Set<ConversationRunStatus>([
  'completed',
  'interrupted',
  'failed',
  'uncertain',
  'recoveryRequired',
])

export function isActiveRunStatus(status: ConversationRunStatus): boolean {
  return !terminalRunStatuses.has(status)
}

interface MutableRun {
  readonly runId: WorkspaceExecutionEvent['runId']
  readonly generation: number
  status: ConversationRunStatus
  startedAt: string | null
  observedAt: string | null
  settledAt: string | null
  readonly pending: Map<string, 'approval' | 'question'>
  lastOutput: ConversationRun['lastOutput']
  lastSequence: number
}

type MutableAssistantTurn = Omit<ConversationAssistantTurn, 'blocks' | 'audit' | 'run'> & {
  readonly blocks: ConversationTurnBlock[]
  readonly audit: WorkspaceExecutionEvent[]
  readonly identityKey: string
  readonly runKey: string
}

function runKeyFor(event: WorkspaceExecutionEvent): string {
  return `${event.runId}:${event.generation}`
}

function transitionRun(run: MutableRun, status: ConversationRunStatus, occurredAt: string, reopen = false): void {
  if (terminalRunStatuses.has(run.status) && !terminalRunStatuses.has(status) && !reopen) return
  run.status = status
  run.settledAt = terminalRunStatuses.has(status) ? occurredAt : null
}

/** Folds one durable record into its Run's lifecycle. Terminal states hold until a new native turn starts. */
function observeRun(
  runs: Map<string, MutableRun>,
  event: WorkspaceExecutionEvent,
  driver: AgentDriverEvent | null,
): void {
  const key = runKeyFor(event)
  const run: MutableRun = runs.get(key) ?? {
    runId: event.runId,
    generation: event.generation,
    status: 'active',
    startedAt: null,
    observedAt: event.occurredAt,
    settledAt: null,
    pending: new Map(),
    lastOutput: null,
    lastSequence: event.sequence,
  }
  runs.set(key, run)
  run.lastSequence = event.sequence
  switch (event.kind) {
    case 'runQueued':
      transitionRun(run, 'queued', event.occurredAt)
      return
    case 'dispatchClaimed':
      transitionRun(run, 'starting', event.occurredAt)
      run.startedAt ??= event.occurredAt
      return
    case 'runStarted':
      transitionRun(run, 'active', event.occurredAt)
      run.startedAt ??= event.occurredAt
      return
    case 'runInterruptRequested':
      transitionRun(run, 'interrupting', event.occurredAt)
      return
    case 'runFailed':
      transitionRun(run, 'failed', event.occurredAt)
      return
    case 'runUncertain':
      transitionRun(run, 'uncertain', event.occurredAt)
      return
    case 'runRecoveryRequired':
      transitionRun(run, 'recoveryRequired', event.occurredAt)
      return
    case 'driverEvent':
      break
    default:
      return
  }
  if (!driver) return
  switch (driver.kind) {
    case 'turnStarted':
      transitionRun(run, 'active', event.occurredAt, true)
      run.startedAt ??= event.occurredAt
      if (run.pending.size > 0) transitionRun(run, 'awaitingInput', event.occurredAt)
      break
    case 'turnCompleted':
      transitionRun(run, 'completed', event.occurredAt)
      break
    case 'turnInterrupted':
      transitionRun(run, 'interrupted', event.occurredAt)
      break
    case 'turnFailed':
      transitionRun(run, 'failed', event.occurredAt)
      break
    case 'requestPending':
      run.pending.set(driver.request.requestId, driver.request.kind)
      transitionRun(run, 'awaitingInput', event.occurredAt)
      break
    case 'requestResolved':
      run.pending.delete(driver.requestId)
      if (run.pending.size === 0 && run.status === 'awaitingInput') transitionRun(run, 'active', event.occurredAt)
      break
    case 'reasoningDelta':
      run.lastOutput = 'reasoning'
      break
    case 'textDelta':
      run.lastOutput = 'text'
      break
    case 'toolStarted':
    case 'toolUpdated':
    case 'toolCompleted':
      run.lastOutput = 'tool'
      break
    default:
      break
  }
}

function snapshotRun(run: MutableRun): ConversationRun {
  const pending = [...run.pending.values()]
  return {
    runId: run.runId,
    generation: run.generation,
    status: run.status,
    startedAt: run.startedAt,
    observedAt: run.observedAt,
    settledAt: run.settledAt,
    pendingRequestKind: pending.at(-1) ?? null,
    lastOutput: run.lastOutput,
  }
}

function activityFor(runs: ReadonlyMap<string, MutableRun>): ConversationActivity | null {
  let latest: MutableRun | null = null
  for (const run of runs.values()) if (!latest || run.lastSequence > latest.lastSequence) latest = run
  if (!latest || !isActiveRunStatus(latest.status)) return null
  const pendingKind = [...latest.pending.values()].at(-1)
  const label: ConversationActivity['label'] =
    latest.status !== 'awaitingInput'
      ? latest.lastOutput === 'reasoning'
        ? 'thinking'
        : 'working'
      : pendingKind === 'approval'
        ? 'awaitingApproval'
        : 'awaitingAnswer'
  return {
    runId: latest.runId,
    generation: latest.generation,
    label,
    since: latest.startedAt ?? latest.observedAt,
  }
}

/** Project ordered durable records into user messages, assistant turns and the live Run activity. */
export function projectConversationView(
  items: readonly WorkspaceConversationPageItem[],
  hydratedEvents: ReadonlyMap<number, WorkspaceExecutionEvent> = new Map(),
): ConversationProjection {
  const ordered = [...items].sort((a, b) => a.event.sequence - b.event.sequence)
  const entries: Array<ConversationUserMessage | ConversationStatusNotice | MutableAssistantTurn> = []
  const users = new Map<string, ConversationUserMessage>()
  const activeNativeTurns = new Map<string, string>()
  const toolStates = new Map<string, Extract<ConversationTurnBlock, { readonly kind: 'tool' }>>()
  const runs = new Map<string, MutableRun>()
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
      observeRun(runs, event, null)
      entries.push({ kind: 'status', id: `status:${event.sequence}`, sequence: event.sequence, event })
      lastTurn = null
      continue
    }
    if (event.kind !== 'driverEvent') continue
    const hydratedEvent = hydratedEvents.get(event.sequence)
    const driver = decodeConversationEvent(hydratedEvent ?? event)
    observeRun(runs, event, driver)
    if (!driver && !event.payloadTruncated) continue
    const runGeneration = runKeyFor(event)
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
        runKey: runGeneration,
        runId: event.runId,
        generation: event.generation,
        nativeTurnId,
        sequence: event.sequence,
        occurredAt: event.occurredAt,
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

  const projected = entries.map((entry): ConversationEntry => {
    if (entry.kind !== 'assistant') return entry
    const run = runs.get(entry.runKey)
    return {
      kind: entry.kind,
      id: entry.id,
      runId: entry.runId,
      generation: entry.generation,
      nativeTurnId: entry.nativeTurnId,
      sequence: entry.sequence,
      occurredAt: entry.occurredAt,
      run: run
        ? snapshotRun(run)
        : {
            runId: entry.runId,
            generation: entry.generation,
            status: 'active',
            startedAt: null,
            observedAt: entry.occurredAt,
            settledAt: null,
            pendingRequestKind: null,
            lastOutput: null,
          },
      blocks: [...entry.blocks],
      audit: [...entry.audit],
    }
  })
  return { entries: projected, activity: activityFor(runs) }
}

/** Entries only, for callers that do not render the live activity. */
export function projectConversation(
  items: readonly WorkspaceConversationPageItem[],
  hydratedEvents: ReadonlyMap<number, WorkspaceExecutionEvent> = new Map(),
): ConversationEntry[] {
  return projectConversationView(items, hydratedEvents).entries
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
    case 'capabilitiesUpdated':
      return 'Agent controls updated'
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
