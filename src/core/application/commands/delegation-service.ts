import { createHash, randomUUID } from 'node:crypto'

import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'

import { ExecutionService } from '@/core/application/commands/execution-service.js'
import { DelegationCoordinator } from '@/core/application/execution/delegation-coordinator.js'
import { ACCESS_MODE_RANK, narrowChildAccessMode } from '@/core/domain/delegation/access-narrowing.js'
import { delegationStatusFromRun, isSettledDelegationStatus } from '@/core/domain/delegation/status.js'
import { agentDriverAccessModes, UnsupportedAgentOperation } from '@/core/ports/agent-driver.js'
import { AgentDriverRegistry } from '@/core/ports/agent-driver-registry.js'
import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import {
  DELEGATION_MAX_ACTIVE_PER_PARENT_RUN,
  DELEGATION_MAX_DEPTH,
  type DelegationCaller,
  type DelegationCapabilities,
  DelegationError,
  type DelegationId,
  type DelegationIsolation,
  type DelegationList,
  type DelegationModelChoice,
  type DelegationRecord,
  type DelegationRole,
  type DelegationSummary,
  type DelegationTargetChoice,
} from '@/shared/schemas/delegation.js'
import type { AgentAccessMode, AgentRunStatus } from '@/shared/schemas/execution.js'
import { agentDriverEventSchema, DEFAULT_AGENT_ACCESS_MODE } from '@/shared/schemas/execution.js'
import type {
  AgentRunId,
  ConversationId,
  ProjectId,
  TaskId,
  WorkspaceCheckout,
  WorkspaceCheckoutId,
} from '@/shared/schemas/workspace.js'
import { WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

/** The Run that makes a call. Built by the platform layer from the endpoint, never from tool arguments. */
export interface DelegationCallerScope extends DelegationCaller {
  readonly accessMode: AgentAccessMode
}

/** Normalized start request. The tool layer maps its arguments onto this shape. */
export interface StartDelegationRequest {
  readonly task: string
  readonly title?: string | undefined
  readonly target?:
    | {
        readonly connectionId: string
        readonly modelId?: string | undefined
        readonly modeId?: string | undefined
      }
    | undefined
  readonly isolation?: DelegationIsolation | undefined
  readonly accessMode?: AgentAccessMode | undefined
  readonly role?: DelegationRole | undefined
  readonly wait: boolean
  readonly waitTimeoutMs: number
  readonly clientRequestId?: string | undefined
}

/** A connection a Delegated Task may run on. Every connection is a valid target, including ACP connections. */
export interface DelegationConnectionRef {
  readonly id: string
  readonly label: string
  readonly driverId: string
  /** The models its cached catalog lists. Absent until the connection has been inspected. */
  readonly models?: ReadonlyArray<DelegationModelChoice> | undefined
}

export interface DelegationServiceOptions {
  readonly loadConnections: () => Effect.Effect<ReadonlyArray<DelegationConnectionRef>>
  /** The execution owner epoch, needed to steer or answer a live child. Absent means only settled children resume. */
  readonly ownerEpoch?: number | undefined
  /** Creates an isolated checkout for `isolation: 'worktree'`. Absent means worktrees are unavailable. */
  readonly createWorktree?:
    | ((request: {
        readonly commandId: string
        readonly token: string
        readonly checkoutId: WorkspaceCheckoutId
        readonly projectId: ProjectId
        readonly baseBranch: string
      }) => Effect.Effect<WorkspaceCheckout, unknown>)
    | undefined
}

/** A bounded view of a Delegated Task's Conversation, newest messages last. */
export interface DelegationTranscript {
  readonly summary: DelegationSummary
  readonly messages: ReadonlyArray<{ readonly role: 'task' | 'agent'; readonly text: string; readonly truncated: boolean }>
  readonly earlierOmitted: boolean
  readonly pendingRequest?:
    | {
        readonly kind: 'approval' | 'question'
        readonly prompt: string
        readonly questions: ReadonlyArray<{ readonly id: string; readonly prompt: string; readonly options: ReadonlyArray<string> }>
      }
    | undefined
}

export interface SendDelegationRequest {
  readonly message: string
  /** Answers by question id. Without it, `message` answers every open question. */
  readonly answers?: Readonly<Record<string, string>> | undefined
  readonly clientRequestId?: string | undefined
}

export interface DelegationListing {
  readonly items: ReadonlyArray<DelegationSummary>
  readonly truncated: boolean
}

const LIVE_PARENT_STATUSES: ReadonlyArray<AgentRunStatus> = ['starting', 'running', 'awaitingInput']
const RUN_SCAN = 500
const TITLE_MAX = 80
const NEXT_LIVE = 'Completion wakes this run. Do not poll; continue other work or end your turn.'
const READ_MESSAGE_MAX = 4_000
const READ_PAGE = 200

/** The task as the child receives it. A role other than `general` frames it. */
const framedTask = (task: string, role: DelegationRole | undefined) =>
  role === undefined || role === 'general' ? task : `Act as the ${role} agent for this delegated task.\n\n${task}`

const sendFailure = (error: unknown) =>
  error instanceof DelegationError
    ? error
    : new DelegationError({
        code: 'unavailable',
        message:
          error instanceof UnsupportedAgentOperation
            ? 'This connection cannot take a message while the delegated task runs.'
            : 'The message could not be delivered.',
      })

const token = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24)

const storeFailure = () => new DelegationError({ code: 'unavailable', message: 'Delegation storage is unavailable.' })

/** Maps a store refusal of a write onto the stable delegation error codes. */
const writeFailure = (error: WorkspaceStoreError): DelegationError => {
  switch (error.code) {
    case 'invalid-transition':
    case 'not-found':
      return new DelegationError({ code: 'parent-not-active', message: 'This run is no longer active.' })
    case 'admission-conflict':
      return new DelegationError({ code: 'limit-exceeded', message: 'The run cannot start another delegation now.' })
    case 'command-conflict':
      return new DelegationError({ code: 'conflict', message: 'This client request id was used with other input.' })
    default:
      return storeFailure()
  }
}

const notFound = () => new DelegationError({ code: 'not-found', message: 'Delegation was not found.' })

/** A Delegation is visible only to the Task that started it, so a grandparent or a sibling sees not-found. */
const ownedBy = (record: DelegationRecord | null, caller: DelegationCallerScope): Effect.Effect<DelegationRecord, DelegationError> =>
  record && record.parentTaskId === caller.taskId ? Effect.succeed(record) : Effect.fail(notFound())

export class DelegationService extends Context.Service<
  DelegationService,
  {
    readonly capabilities: (caller: DelegationCallerScope) => Effect.Effect<DelegationCapabilities, DelegationError>
    readonly start: (
      caller: DelegationCallerScope,
      request: StartDelegationRequest,
    ) => Effect.Effect<DelegationSummary, DelegationError>
    readonly status: (
      caller: DelegationCallerScope,
      delegationId: DelegationId,
    ) => Effect.Effect<DelegationSummary, DelegationError>
    readonly list: (caller: DelegationCallerScope, limit: number) => Effect.Effect<DelegationListing, DelegationError>
    readonly cancel: (
      caller: DelegationCallerScope,
      delegationId: DelegationId,
    ) => Effect.Effect<DelegationSummary, DelegationError>
    readonly read: (
      caller: DelegationCallerScope,
      delegationId: DelegationId,
      limit: number,
    ) => Effect.Effect<DelegationTranscript, DelegationError>
    /** Answers an open question, steers a running child, or resumes a settled one with a follow-up Run. */
    readonly send: (
      caller: DelegationCallerScope,
      delegationId: DelegationId,
      request: SendDelegationRequest,
    ) => Effect.Effect<DelegationSummary, DelegationError>
    /** Read for the Workspace UI, scoped to one Task's own delegations, optionally to one parent Run. */
    readonly listForTask: (query: {
      readonly taskId: TaskId
      readonly runId?: AgentRunId | undefined
      readonly limit: number
    }) => Effect.Effect<DelegationList, DelegationError>
    /** Stop from the Workspace UI. The user, not an Agent Run, is the caller. */
    readonly cancelFromUser: (delegationId: DelegationId) => Effect.Effect<DelegationRecord, DelegationError>
  }
>()('watchtower/core/application/DelegationService') {
  static readonly layer = (options: DelegationServiceOptions) =>
    Layer.effect(
      DelegationService,
      Effect.gen(function* () {
        const store = yield* WorkspaceStore
        const execution = yield* ExecutionService
        const coordinator = yield* DelegationCoordinator
        const drivers = yield* AgentDriverRegistry

        const now = Effect.map(DateTime.now, DateTime.formatIso)

        const accessModesOf = (driverId: string) =>
          drivers.resolve(driverId).pipe(
            Effect.map(driver => agentDriverAccessModes(driver)),
            Effect.catch(() => Effect.succeed([DEFAULT_AGENT_ACCESS_MODE])),
          )

        /** The parent's view of a child. A settled Delegation keeps its stored status; a live one reads its Run. */
        const liveStatus = Effect.fn('DelegationService.liveStatus')(function* (record: DelegationRecord) {
          if (record.settledAt !== null) return record.status
          const snapshot = yield* store.readTaskSnapshot(record.childTaskId, 20).pipe(Effect.option)
          const runStatus = Option.isSome(snapshot)
            ? (snapshot.value.runs.find(run => run.id === record.childRunId)?.status ?? null)
            : null
          return delegationStatusFromRun({
            runStatus,
            cancelRequested: record.cancelRequestedAt !== null,
            pendingRequest: record.pendingRequest !== null,
          })
        })

        const summaryOf = Effect.fn('DelegationService.summaryOf')(function* (
          record: DelegationRecord,
          waitTimedOut: boolean,
        ) {
          const status = yield* liveStatus(record)
          const settled = isSettledDelegationStatus(status)
          return {
            delegationId: record.id,
            childTaskId: record.childTaskId,
            title: record.title,
            status,
            settled,
            cancelRequested: record.cancelRequestedAt !== null,
            connectionId: record.connectionId,
            modelId: record.modelId,
            accessMode: record.accessMode,
            accessModeSteppedDownFrom: record.accessModeSteppedDownFrom,
            isolation: record.isolation,
            pendingRequest: record.pendingRequest,
            resultText: record.resultText,
            resultTruncated: record.resultTruncated,
            waitTimedOut,
            ...(settled ? {} : { next: NEXT_LIVE }),
          } satisfies DelegationSummary
        })

        /** The parent Run must be live. A stop request or a finished Run cannot start or resume children. */
        const liveParent = Effect.fn('DelegationService.liveParent')(function* (caller: DelegationCallerScope) {
          const snapshot = yield* store.readTaskSnapshot(caller.taskId, RUN_SCAN).pipe(Effect.mapError(storeFailure))
          const parentRun = snapshot.runs.find(run => run.id === caller.runId)
          const parentContext = snapshot.runContexts?.find(context => context.runId === caller.runId)
          if (!parentRun || !parentContext || !LIVE_PARENT_STATUSES.includes(parentRun.status))
            return yield* new DelegationError({ code: 'parent-not-active', message: 'This run is not active.' })
          return parentContext
        })

        const capabilities = Effect.fn('DelegationService.capabilities')(function* (caller: DelegationCallerScope) {
          const link = yield* store.getDelegationByChildTask(caller.taskId).pipe(Effect.mapError(storeFailure))
          const active = yield* store
            .listDelegations({ parentRunId: caller.runId, activeOnly: true, limit: DELEGATION_MAX_ACTIVE_PER_PARENT_RUN })
            .pipe(Effect.mapError(storeFailure))
          const loaded = yield* options.loadConnections()
          const connections: Array<DelegationTargetChoice> = []
          for (const connection of loaded.slice(0, 64)) {
            const models = (connection.models ?? []).slice(0, 64)
            connections.push({
              connectionId: connection.id,
              label: connection.label,
              driverId: connection.driverId,
              accessModes: yield* accessModesOf(connection.driverId),
              models,
              // A connection that lists no models is treated as unknown, so the caller may name a model freely.
              modelsKnown: models.length > 0,
            })
          }
          const depth = link?.depth ?? 0
          return {
            parentAccessMode: caller.accessMode,
            depth,
            remainingDepth: Math.max(0, DELEGATION_MAX_DEPTH - depth),
            activeCount: active.items.length,
            maxActive: DELEGATION_MAX_ACTIVE_PER_PARENT_RUN,
            connections,
          } satisfies DelegationCapabilities
        })

        const start = Effect.fn('DelegationService.start')(function* (
          caller: DelegationCallerScope,
          request: StartDelegationRequest,
        ) {
          // Identifiers derive from the parent Run and the client request id, so a retry addresses the same Delegation.
          // The retry is answered before any limit or liveness check, which would otherwise refuse a replay.
          const clientKey =
            request.clientRequestId === undefined ? undefined : token(`${caller.runId}:${request.clientRequestId}`)
          if (clientKey !== undefined) {
            const replayed = yield* store.getDelegation(`dlg-${clientKey}`).pipe(Effect.mapError(storeFailure))
            if (replayed) return yield* summaryOf(yield* ownedBy(replayed, caller), false)
          }

          const parentContext = yield* liveParent(caller)

          const link = yield* store.getDelegationByChildTask(caller.taskId).pipe(Effect.mapError(storeFailure))
          const depth = (link?.depth ?? 0) + 1
          if (depth > DELEGATION_MAX_DEPTH)
            return yield* new DelegationError({
              code: 'depth-exceeded',
              message: 'A delegated task cannot start another delegated task.',
            })

          const active = yield* store
            .listDelegations({ parentRunId: caller.runId, activeOnly: true, limit: DELEGATION_MAX_ACTIVE_PER_PARENT_RUN })
            .pipe(Effect.mapError(storeFailure))
          if (active.items.length >= DELEGATION_MAX_ACTIVE_PER_PARENT_RUN)
            return yield* new DelegationError({
              code: 'limit-exceeded',
              message: `This run already has ${DELEGATION_MAX_ACTIVE_PER_PARENT_RUN} active delegations.`,
            })

          const connections = yield* options.loadConnections()
          const connectionId = request.target?.connectionId ?? parentContext.connectionId
          const choice = connections.find(connection => connection.id === connectionId)
          if (!choice)
            return yield* new DelegationError({ code: 'connection-unavailable', message: 'That connection is not available.' })
          // A named model that the catalog lists must offer the requested effort. An unlisted model is passed through.
          const listedModel = choice.models?.find(model => model.id === request.target?.modelId)
          if (
            listedModel &&
            request.target?.modeId !== undefined &&
            !(listedModel.modes ?? []).some(mode => mode.id === request.target?.modeId)
          )
            return yield* new DelegationError({
              code: 'invalid-request',
              message: 'That model does not offer the requested effort.',
            })
          const narrowing = narrowChildAccessMode({
            parent: caller.accessMode,
            requested: request.accessMode,
            supported: yield* accessModesOf(choice.driverId),
          })
          if (narrowing.outcome === 'refused')
            return yield* new DelegationError({ code: narrowing.code, message: narrowing.message })

          const key = clientKey ?? token(randomUUID())
          const id = `dlg-${key}` as DelegationId
          const commandId = `delegation:${key}`
          const childTaskId = `task-${key}` as TaskId
          const childConversationId = `conv-${key}` as ConversationId
          const childRunId = `run-${key}` as AgentRunId
          const createdAt = yield* now
          const isolation: DelegationIsolation = request.isolation ?? 'shared'

          let checkoutId = parentContext.checkoutId
          if (isolation === 'worktree') {
            if (!options.createWorktree)
              return yield* new DelegationError({ code: 'checkout-unavailable', message: 'Worktree isolation is not available.' })
            const project = yield* store.getProject(caller.projectId).pipe(Effect.mapError(storeFailure))
            const parentCheckout = [project.mainCheckout, ...project.otherCheckouts].find(
              checkout => checkout.id === parentContext.checkoutId,
            )
            const created = yield* options
              .createWorktree({
                commandId: `delegation-worktree:${key}`,
                token: key,
                checkoutId: parentContext.checkoutId,
                projectId: caller.projectId,
                baseBranch: parentCheckout?.branch ?? 'HEAD',
              })
              .pipe(
                Effect.mapError(
                  () => new DelegationError({ code: 'checkout-unavailable', message: 'The worktree could not be created.' }),
                ),
              )
            checkoutId = created.id
          }

          const title = (request.title ?? request.task.split('\n')[0] ?? '').trim().slice(0, TITLE_MAX)
          const record: DelegationRecord = {
            id,
            commandId,
            projectId: caller.projectId,
            parentTaskId: caller.taskId,
            parentConversationId: caller.conversationId,
            parentRunId: caller.runId,
            childTaskId,
            childConversationId,
            childRunId,
            checkoutId,
            depth,
            title: title.length > 0 ? title : 'Delegated task',
            driverId: choice.driverId,
            connectionId: choice.id,
            modelId: request.target ? (request.target.modelId ?? null) : (parentContext.modelId ?? null),
            modeId: request.target?.modeId ?? null,
            accessMode: narrowing.mode,
            accessModeRequested: request.accessMode ?? null,
            accessModeSteppedDownFrom: narrowing.steppedDownFrom,
            isolation,
            status: 'queued',
            wake: request.wait ? 'settledOnly' : 'always',
            wakeState: 'notDue',
            pendingRequest: null,
            resultText: null,
            resultTruncated: false,
            cancelRequestedAt: null,
            resultReadAt: null,
            createdAt,
            settledAt: null,
          }

          const receipt = yield* store
            .createDelegation({
              commandId,
              issuedAt: createdAt,
              parentRunId: caller.runId,
              parentTaskId: caller.taskId,
              parentConversationId: caller.conversationId,
              task: { id: childTaskId, projectId: caller.projectId, title: record.title, description: '', createdAt },
              conversation: { id: childConversationId, title: record.title, createdAt },
              record,
              limits: { maxDepth: DELEGATION_MAX_DEPTH, maxActivePerParentRun: DELEGATION_MAX_ACTIVE_PER_PARENT_RUN },
            })
            .pipe(Effect.mapError(writeFailure))

          if (receipt.replayed) {
            // A retry returns the stored Delegation and does not launch a second child.
            const existing = yield* store.getDelegation(receipt.delegationId).pipe(Effect.mapError(storeFailure))
            return yield* summaryOf(yield* ownedBy(existing, caller), false)
          }

          const launch = coordinator
            .launch(id, {
              commandId: `delegation-run:${key}`,
              issuedAt: createdAt,
              runId: childRunId,
              taskId: childTaskId,
              conversationId: childConversationId,
              checkoutId,
              provisionalAgentSessionId: `delegation-session:${key}`,
              generation: 1,
              driverId: choice.driverId,
              connectionId: choice.id,
              prompt: framedTask(request.task, request.role),
              attachments: [],
              modelId: record.modelId,
              modeId: record.modeId,
              accessMode: narrowing.mode,
              nativeSessionId: null,
              retryOfRunId: null,
              origin: 'delegation',
              delegationId: id,
            })
            .pipe(
              Effect.catch(() =>
                coordinator.settleLaunchFailure(id).pipe(
                  Effect.mapError(error => (error instanceof DelegationError ? error : storeFailure())),
                ),
              ),
              Effect.mapError(error => (error instanceof DelegationError ? error : storeFailure())),
            )

          if (!request.wait) {
            yield* launch
            return yield* summaryOf(yield* ownedBy(yield* store.getDelegation(id).pipe(Effect.mapError(storeFailure)), caller), false)
          }
          // The waiter is registered before launch, so a child that settles during launch still reaches this caller.
          const watch = yield* coordinator
            .watch(id)
            .pipe(Effect.mapError(error => (error instanceof DelegationError ? error : storeFailure())))
          const settled = yield* launch.pipe(
            Effect.flatMap(() => watch.awaitSettled(request.waitTimeoutMs).pipe(Effect.mapError(storeFailure))),
            Effect.ensuring(watch.release()),
          )
          if (settled) return yield* summaryOf(settled, false)
          return yield* summaryOf(yield* ownedBy(yield* store.getDelegation(id).pipe(Effect.mapError(storeFailure)), caller), true)
        })

        const status = Effect.fn('DelegationService.status')(function* (
          caller: DelegationCallerScope,
          delegationId: DelegationId,
        ) {
          const record = yield* ownedBy(yield* store.getDelegation(delegationId).pipe(Effect.mapError(storeFailure)), caller)
          // Reading a settled result marks it read; the wake is the first delivery, this is the explicit one.
          const current =
            record.settledAt !== null && record.resultReadAt === null
              ? yield* store.markDelegationRead(record.id, yield* now).pipe(Effect.mapError(storeFailure))
              : record
          return yield* summaryOf(current, false)
        })

        const list = Effect.fn('DelegationService.list')(function* (caller: DelegationCallerScope, limit: number) {
          const page = yield* store.listDelegations({ parentTaskId: caller.taskId, limit }).pipe(Effect.mapError(storeFailure))
          const items: Array<DelegationSummary> = []
          for (const record of page.items) items.push(yield* summaryOf(record, false))
          return { items, truncated: page.truncated }
        })

        const cancel = Effect.fn('DelegationService.cancel')(function* (
          caller: DelegationCallerScope,
          delegationId: DelegationId,
        ) {
          yield* ownedBy(yield* store.getDelegation(delegationId).pipe(Effect.mapError(storeFailure)), caller)
          const record = yield* coordinator
            .cancel(delegationId)
            .pipe(Effect.mapError(error => (error instanceof DelegationError ? error : storeFailure())))
          return yield* summaryOf(record, false)
        })

        const read = Effect.fn('DelegationService.read')(function* (
          caller: DelegationCallerScope,
          delegationId: DelegationId,
          limit: number,
        ) {
          const owned = yield* ownedBy(yield* store.getDelegation(delegationId).pipe(Effect.mapError(storeFailure)), caller)
          const page = yield* store
            .readConversationPage(owned.childConversationId, 0, READ_PAGE, undefined, { direction: 'backward' })
            .pipe(Effect.mapError(storeFailure))
          const messages: Array<{ role: 'task' | 'agent'; runId: string | null; text: string }> = []
          for (const item of [...page.items].sort((left, right) => left.event.sequence - right.event.sequence)) {
            if (item.userMessage) {
              messages.push({ role: 'task', runId: null, text: item.userMessage.content })
              continue
            }
            const event = item.event
            if (event.kind !== 'driverEvent' || event.payloadTruncated) continue
            const decoded = Schema.decodeUnknownOption(agentDriverEventSchema)(event.data['event'])
            if (Option.isNone(decoded) || decoded.value.kind !== 'textDelta') continue
            const last = messages.at(-1)
            if (last?.role === 'agent' && last.runId === event.runId) last.text += decoded.value.text
            else messages.push({ role: 'agent', runId: event.runId, text: decoded.value.text })
          }
          const kept = messages.filter(message => message.text.trim().length > 0).slice(-limit)
          let pendingRequest: DelegationTranscript['pendingRequest']
          if (owned.pendingRequest) {
            const requests = yield* store
              .listPendingRuntimeRequests(owned.childTaskId, 0, 20)
              .pipe(Effect.mapError(storeFailure))
            const open = requests.items.find(item => item.request.requestId === owned.pendingRequest?.requestId)
            if (open)
              pendingRequest = {
                kind: open.request.kind,
                prompt: open.request.prompt.slice(0, READ_MESSAGE_MAX),
                questions: open.request.questions.map(question => ({
                  id: question.id,
                  prompt: question.prompt,
                  options: question.options.map(option => option.label),
                })),
              }
          }
          const current =
            owned.settledAt !== null && owned.resultReadAt === null
              ? yield* store.markDelegationRead(owned.id, yield* now).pipe(Effect.mapError(storeFailure))
              : owned
          return {
            summary: yield* summaryOf(current, false),
            messages: kept.map(message => {
              const truncated = message.text.length > READ_MESSAGE_MAX
              // An agent's answer ends its message, so a long one keeps its end; a task keeps its start.
              const text = !truncated
                ? message.text
                : message.role === 'agent'
                  ? message.text.slice(-READ_MESSAGE_MAX)
                  : message.text.slice(0, READ_MESSAGE_MAX)
              return { role: message.role, text, truncated }
            }),
            earlierOmitted: kept.length < messages.length || (page.nextBeforeSequence ?? null) !== null,
            ...(pendingRequest ? { pendingRequest } : {}),
          } satisfies DelegationTranscript
        })

        const steerOrAnswer = Effect.fn('DelegationService.steerOrAnswer')(function* (
          record: DelegationRecord,
          request: SendDelegationRequest,
          key: string,
        ) {
          const ownerEpoch = options.ownerEpoch
          const snapshot = yield* store.readTaskSnapshot(record.childTaskId, 20).pipe(Effect.mapError(storeFailure))
          const run = snapshot.runs.find(item => item.id === record.childRunId)
          if (ownerEpoch === undefined || !run)
            return yield* new DelegationError({ code: 'unavailable', message: 'The message could not be delivered.' })
          const issuedAt = yield* now
          const pending = record.pendingRequest
          if (!pending) {
            yield* execution
              .steer({
                commandId: `delegation-steer:${key}`,
                issuedAt,
                runId: run.id,
                ownerEpoch,
                generation: run.generation,
                message: request.message,
              })
              .pipe(Effect.mapError(sendFailure))
            return
          }
          if (pending.kind === 'approval')
            return yield* new DelegationError({
              code: 'invalid-request',
              message: 'This delegated task waits on an approval that only the user can give.',
            })
          const requests = yield* store
            .listPendingRuntimeRequests(record.childTaskId, 0, 20)
            .pipe(Effect.mapError(storeFailure))
          const open = requests.items.find(item => item.request.requestId === pending.requestId)
          if (!open) return yield* new DelegationError({ code: 'conflict', message: 'That question was already answered.' })
          yield* execution
            .respond({
              commandId: `delegation-answer:${key}`,
              issuedAt,
              runId: run.id,
              ownerEpoch,
              generation: run.generation,
              requestId: pending.requestId,
              decision: {
                kind: 'answers',
                answers: Object.fromEntries(
                  open.request.questions.map(question => [question.id, request.answers?.[question.id] ?? request.message]),
                ),
              },
            })
            .pipe(Effect.mapError(sendFailure))
        })

        const resumeSettled = Effect.fn('DelegationService.resumeSettled')(function* (
          caller: DelegationCallerScope,
          record: DelegationRecord,
          request: SendDelegationRequest,
          key: string,
        ) {
          yield* liveParent(caller)
          const active = yield* store
            .listDelegations({ parentRunId: caller.runId, activeOnly: true, limit: DELEGATION_MAX_ACTIVE_PER_PARENT_RUN })
            .pipe(Effect.mapError(storeFailure))
          if (active.items.length >= DELEGATION_MAX_ACTIVE_PER_PARENT_RUN)
            return yield* new DelegationError({
              code: 'limit-exceeded',
              message: `This run already has ${DELEGATION_MAX_ACTIVE_PER_PARENT_RUN} active delegations.`,
            })
          const snapshot = yield* store.readTaskSnapshot(record.childTaskId, 20).pipe(Effect.mapError(storeFailure))
          const context = snapshot.runContexts?.find(item => item.runId === record.childRunId)
          const driverId = context?.driverId ?? record.driverId
          const connectionId = context?.connectionId ?? record.connectionId
          // The follow-up never runs broader than the Run that asks for it, nor broader than the child ran before.
          const narrowing = narrowChildAccessMode({
            parent: caller.accessMode,
            requested:
              ACCESS_MODE_RANK[record.accessMode] <= ACCESS_MODE_RANK[caller.accessMode] ? record.accessMode : undefined,
            supported: yield* accessModesOf(driverId),
          })
          if (narrowing.outcome === 'refused')
            return yield* new DelegationError({ code: narrowing.code, message: narrowing.message })
          const sessions = yield* store
            .listNativeAgentSessions(record.childTaskId, { limit: 50 })
            .pipe(Effect.mapError(storeFailure))
          const session = sessions.items
            .filter(
              item =>
                item.conversationId === record.childConversationId &&
                item.connectionId === connectionId &&
                (item.status === 'active' || item.status === 'suspended') &&
                // A session the driver cannot load again would fail the resume, so the follow-up starts fresh.
                item.capabilities?.loadSession.support !== 'unsupported',
            )
            .sort((left, right) => right.generation - left.generation)[0]
          const childRunId = `run-${key}` as AgentRunId
          const resumed = yield* coordinator
            .resume(
              record.id,
              {
                commandId: `delegation-reopen:${key}`,
                delegationId: record.id,
                parentRunId: caller.runId,
                childRunId,
                accessMode: narrowing.mode,
                maxActivePerParentRun: DELEGATION_MAX_ACTIVE_PER_PARENT_RUN,
                occurredAt: yield* now,
              },
              {
                commandId: `delegation-run:${key}`,
                issuedAt: yield* now,
                runId: childRunId,
                taskId: record.childTaskId,
                conversationId: record.childConversationId,
                checkoutId: context?.checkoutId ?? record.checkoutId,
                provisionalAgentSessionId: `delegation-session:${key}`,
                generation: session?.generation ?? 1,
                driverId,
                connectionId,
                prompt: request.message,
                attachments: [],
                modelId: record.modelId,
                modeId: record.modeId,
                accessMode: narrowing.mode,
                nativeSessionId: session?.nativeSessionId ?? null,
                retryOfRunId: null,
                origin: 'delegation',
                delegationId: record.id,
              },
            )
            .pipe(Effect.mapError(error => (error instanceof WorkspaceStoreError ? writeFailure(error) : sendFailure(error))))
          if (resumed === null)
            return yield* new DelegationError({
              code: 'conflict',
              message: 'The delegated task is running again. Send the message again to reach it.',
            })
          return resumed
        })

        const alreadySent = Effect.fn('DelegationService.alreadySent')(function* (record: DelegationRecord, key: string) {
          if (record.childRunId === `run-${key}`) return true
          const [snapshot, steers, answers] = yield* Effect.all([
            store.readTaskSnapshot(record.childTaskId, RUN_SCAN),
            store.listSteerIntents(record.childTaskId, { limit: 50 }),
            store.listRequestResponses(record.childTaskId, { limit: 50 }),
          ]).pipe(Effect.mapError(storeFailure))
          return (
            snapshot.runs.some(run => run.id === `run-${key}`) ||
            steers.items.some(item => item.commandId === `delegation-steer:${key}`) ||
            answers.items.some(item => item.commandId === `delegation-answer:${key}`)
          )
        })

        const send = Effect.fn('DelegationService.send')(function* (
          caller: DelegationCallerScope,
          delegationId: DelegationId,
          request: SendDelegationRequest,
        ) {
          const record = yield* ownedBy(yield* store.getDelegation(delegationId).pipe(Effect.mapError(storeFailure)), caller)
          const key = token(`${caller.runId}:send:${request.clientRequestId ?? randomUUID()}`)
          // A retry repeats the action its first call took, whatever state the child is in now.
          if (request.clientRequestId !== undefined && (yield* alreadySent(record, key))) return yield* summaryOf(record, false)
          if (isSettledDelegationStatus(yield* liveStatus(record))) {
            if (record.cancelRequestedAt !== null && record.status === 'cancelled')
              return yield* new DelegationError({
                code: 'invalid-request',
                message: 'This delegated task was stopped. Start a new one instead.',
              })
            return yield* summaryOf(yield* resumeSettled(caller, record, request, key), false)
          }
          yield* steerOrAnswer(record, request, key)
          return yield* summaryOf(
            yield* ownedBy(yield* store.getDelegation(delegationId).pipe(Effect.mapError(storeFailure)), caller),
            false,
          )
        })

        return DelegationService.of({
          capabilities,
          start,
          status,
          list,
          cancel,
          read,
          send,
          listForTask: query =>
            store
              .listDelegations({
                parentTaskId: query.taskId,
                ...(query.runId ? { parentRunId: query.runId } : {}),
                limit: query.limit,
              })
              .pipe(Effect.mapError(storeFailure)),
          cancelFromUser: delegationId =>
            coordinator.cancel(delegationId).pipe(
              Effect.mapError(error => (error instanceof DelegationError ? error : storeFailure())),
            ),
        })
      }),
    )
}
