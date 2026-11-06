import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import type { WorkspaceEventFrame } from '@/shared/rpc/workspace.js'
import { agentDriverEventSchema, type AgentRunStatus } from '@/shared/schemas/execution.js'
import { conversationIdSchema } from '@/shared/schemas/workspace.js'
import type { WorkspaceExecutionEvent } from '@/shared/schemas/workspace-store.js'

export interface WorkspaceAttention {
  readonly waitingRequest: boolean
  readonly failed: boolean
  readonly interrupted: boolean
  readonly uncertainDelivery: boolean
  readonly incompletePayload: boolean
}
export interface WorkspaceRunProjection {
  readonly runId: WorkspaceExecutionEvent['runId']
  readonly conversationId: Schema.Schema.Type<typeof conversationIdSchema> | null
  readonly nativeTurnId: string | null
  readonly failedDelivery: boolean
  readonly generation: number
  readonly status: AgentRunStatus
  readonly pendingRequestIds: readonly string[]
  readonly pendingRequestCount: number
  readonly uncertainDelivery: boolean
  readonly incompletePayload: boolean
  readonly sequence: number
}
export interface WorkspaceTaskProjection {
  readonly runs: Readonly<Record<string, WorkspaceRunProjection>>
  /** Raw ordered deltas, including payloadRef on incomplete records; never interpreted as complete text. */
  readonly transcript: readonly WorkspaceExecutionEvent[]
  readonly truncatedBeforeSequence: number | null
  readonly attention: WorkspaceAttention
}
export interface WorkspaceProjectionLimits {
  readonly transcriptLimit: number
  readonly taskLimit: number
  readonly runLimit: number
}
export interface WorkspaceProjection {
  readonly lastAppliedSequence: number
  readonly tasks: Readonly<Record<string, WorkspaceTaskProjection>>
  readonly limits: WorkspaceProjectionLimits
}
export const createWorkspaceProjection = (limits: Partial<WorkspaceProjectionLimits> = {}): WorkspaceProjection => ({
  lastAppliedSequence: 0,
  tasks: {},
  limits: { transcriptLimit: 200, taskLimit: 100, runLimit: 32, ...limits },
})

const decodeRunIdentity = Schema.decodeUnknownOption(
  Schema.Struct({
    conversationId: Schema.optional(conversationIdSchema),
    nativeTurnId: Schema.optional(Schema.String),
  }),
)
const decodeDriverEvent = Schema.decodeUnknownOption(agentDriverEventSchema)
const decodeSettlement = Schema.decodeUnknownOption(
  Schema.Struct({ outcome: Schema.Literals(['accepted', 'failed', 'uncertain']) }),
)
const terminal = new Set<AgentRunStatus>(['completed', 'failed', 'interrupted', 'uncertain', 'recoveryRequired'])

function projectRun(
  previous: WorkspaceRunProjection | undefined,
  event: WorkspaceExecutionEvent,
): WorkspaceRunProjection {
  const identity = decodeRunIdentity(event.data)
  let conversationId = previous?.conversationId ?? null
  let nativeTurnId = previous?.nativeTurnId ?? null
  if (Option.isSome(identity)) {
    conversationId = identity.value.conversationId ?? conversationId
    nativeTurnId = identity.value.nativeTurnId ?? nativeTurnId
  }
  let failedDelivery = previous?.failedDelivery ?? false
  let status: AgentRunStatus = previous?.status ?? 'queued'
  let pendingRequestIds = previous?.pendingRequestIds ?? []
  let pendingRequestCount = previous?.pendingRequestCount ?? 0
  let uncertainDelivery = previous?.uncertainDelivery ?? false
  const incompletePayload = (previous?.incompletePayload ?? false) || event.payloadTruncated === true
  switch (event.kind) {
    case 'runQueued':
      status = 'queued'
      break
    case 'dispatchClaimed':
      status = 'starting'
      break
    case 'runStarted':
      status = 'running'
      break
    case 'runFailed':
      status = 'failed'
      break
    case 'runUncertain':
      status = 'uncertain'
      break
    case 'runRecoveryRequired':
      status = 'recoveryRequired'
      break
    case 'runInterruptRequested':
      status = 'interruptRequested'
      break
    case 'requestResponseSettled':
    case 'steerSettled': {
      const settlement = decodeSettlement(event.data)
      if (Option.isSome(settlement)) {
        if (settlement.value.outcome === 'uncertain') uncertainDelivery = true
        if (settlement.value.outcome === 'failed') failedDelivery = true
      }
      break
    }
    case 'driverEvent': {
      const decoded = event.payloadTruncated ? Option.none() : decodeDriverEvent(event.data.event)
      if (Option.isNone(decoded)) break
      const driver = decoded.value
      switch (driver.kind) {
        case 'turnStarted':
          nativeTurnId = driver.nativeTurnId ?? nativeTurnId
          status = 'running'
          break
        case 'turnCompleted':
          status = 'completed'
          break
        case 'turnFailed':
          status = 'failed'
          break
        case 'turnInterrupted':
          status = 'interrupted'
          break
        case 'requestPending':
          if (!pendingRequestIds.includes(driver.request.requestId)) pendingRequestCount++
          pendingRequestIds = [...new Set([...pendingRequestIds, driver.request.requestId])].slice(-50)
          status = 'awaitingInput'
          break
        case 'requestResolved':
          pendingRequestCount = Math.max(0, pendingRequestCount - 1)
          pendingRequestIds = pendingRequestIds.filter(id => id !== driver.requestId)
          if (pendingRequestCount === 0 && status === 'awaitingInput') status = 'running'
          break
      }
      break
    }
  }
  if (terminal.has(status)) {
    pendingRequestIds = []
    pendingRequestCount = 0
  }
  if (status === 'running' && pendingRequestCount > 0) status = 'awaitingInput'
  return {
    runId: event.runId,
    conversationId,
    nativeTurnId,
    failedDelivery,
    generation: event.generation,
    status,
    pendingRequestIds,
    pendingRequestCount,
    uncertainDelivery,
    incompletePayload,
    sequence: event.sequence,
  }
}

function applyEvent(state: WorkspaceProjection, event: WorkspaceExecutionEvent): WorkspaceProjection {
  const previous = state.tasks[event.taskId]
  const runs = { ...previous?.runs, [event.runId]: projectRun(previous?.runs[event.runId], event) }
  const retainedRuns = Object.fromEntries(
    Object.entries(runs)
      .sort((a, b) => b[1].sequence - a[1].sequence)
      .slice(0, Math.max(1, state.limits.runLimit)),
  )
  const values = Object.values(retainedRuns)
  const transcript = [...(previous?.transcript ?? []), event].slice(-Math.max(1, state.limits.transcriptLimit))
  const truncated =
    previous?.truncatedBeforeSequence != null || (previous?.transcript.length ?? 0) + 1 > state.limits.transcriptLimit
  const task: WorkspaceTaskProjection = {
    runs: retainedRuns,
    transcript,
    truncatedBeforeSequence: truncated ? (transcript[0]?.sequence ?? null) : null,
    attention: {
      waitingRequest: values.some(run => run.pendingRequestCount > 0),
      failed: values.some(run => run.status === 'failed' || run.failedDelivery),
      interrupted: values.some(run => run.status === 'interrupted'),
      uncertainDelivery: values.some(
        run => run.uncertainDelivery || run.status === 'uncertain' || run.status === 'recoveryRequired',
      ),
      incompletePayload: values.some(run => run.incompletePayload),
    },
  }
  // Reinsert the touched task so eviction is least-recently-updated, not alphabetic.
  const tasks = Object.fromEntries(
    [...Object.entries(state.tasks).filter(([id]) => id !== event.taskId), [event.taskId, task] as const].slice(
      -Math.max(1, state.limits.taskLimit),
    ),
  )
  return { ...state, lastAppliedSequence: event.sequence, tasks }
}

/** A gap stops application at the last contiguous event; the caller must resume, never skip it. */
export function applyWorkspaceFrame(state: WorkspaceProjection, frame: WorkspaceEventFrame) {
  const applied: WorkspaceExecutionEvent[] = []
  let resubscribe = frame.page.highWatermark !== frame.throughSequence
  if (resubscribe) return { state, applied, resubscribe }
  for (const event of [...frame.page.events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.sequence <= state.lastAppliedSequence) continue
    if (event.sequence !== state.lastAppliedSequence + 1 || event.sequence > frame.throughSequence) {
      resubscribe = true
      break
    }
    state = applyEvent(state, event)
    applied.push(event)
  }
  resubscribe ||=
    state.lastAppliedSequence < frame.throughSequence && (!frame.page.hasMore || frame.page.events.length === 0)
  return { state, applied, resubscribe }
}

/** The same cursor is used on overflow, EOF and transport disconnect. */
export function workspaceResume(state: WorkspaceProjection, attempt: number) {
  return { afterSequence: state.lastAppliedSequence, delayMs: Math.min(3000, 100 * 2 ** Math.min(attempt, 5)) }
}
