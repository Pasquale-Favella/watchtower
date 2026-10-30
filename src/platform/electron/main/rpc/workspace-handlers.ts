import { createHash } from 'node:crypto'

import * as Cause from 'effect/Cause'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as SubscriptionRef from 'effect/SubscriptionRef'

import { ExecutionServiceError } from '@/core/application/commands/execution-service.js'
import { WorkspaceProjects } from '@/core/application/commands/workspace-projects.js'
import { AgentDriverError, UnsupportedAgentOperation } from '@/core/ports/agent-driver.js'
import { HarnessConnectionResolutionError } from '@/core/ports/harness-connections.js'
import { WorkspaceHost, WorkspaceHostError } from '@/platform/electron/main/workspace/host.js'
import {
  WORKSPACE_RPC_PROTOCOL_VERSION,
  type WorkspaceEventFrame,
  WorkspaceRpcError,
  WorkspaceRpcGroup,
  workspaceStartRunRequestSchema,
} from '@/shared/rpc/workspace.js'
import { CheckoutResolverError } from '@/shared/schemas/checkout.js'
import {
  agentRunIdSchema,
  conversationIdSchema,
  projectIdSchema,
  taskIdSchema,
  workspaceCheckoutIdSchema,
} from '@/shared/schemas/workspace.js'
import * as Store from '@/shared/schemas/workspace-store.js'

const messages = {
  unavailable: 'Workspace is unavailable.',
  'not-found': 'Workspace record was not found.',
  conflict: 'Workspace command conflicts with existing state.',
  stale: 'Workspace command is stale.',
  'invalid-request': 'Workspace request is invalid.',
  failed: 'Workspace operation failed.',
  'stream-overflow': 'Workspace stream exceeded its limit. Resume from the last received sequence.',
} as const
function failure(code: WorkspaceRpcError['code']): WorkspaceRpcError {
  return new WorkspaceRpcError({ code, message: messages[code] })
}
function sanitize(error: unknown): WorkspaceRpcError {
  if (Schema.is(WorkspaceRpcError)(error)) return error
  if (Schema.is(Store.WorkspaceStoreError)(error)) {
    switch (error.code) {
      case 'not-found':
        return failure('not-found')
      case 'database-unavailable':
        return failure('unavailable')
      case 'stale-epoch':
      case 'stale-request':
        return failure('stale')
      case 'invalid-data':
        return failure('invalid-request')
      default:
        return failure('conflict')
    }
  }
  if (Schema.is(WorkspaceHostError)(error)) return failure('unavailable')
  if (Schema.is(ExecutionServiceError)(error))
    return failure(error.reason === 'invalid-options' ? 'invalid-request' : 'unavailable')
  if (Schema.is(HarnessConnectionResolutionError)(error))
    return failure(error.code === 'not-found' ? 'not-found' : 'invalid-request')
  if (Schema.is(AgentDriverError)(error))
    return failure(
      error.code === 'driver-unavailable' || error.code === 'disconnected' || error.code === 'authentication-required'
        ? 'unavailable'
        : 'failed',
    )
  if (Schema.is(UnsupportedAgentOperation)(error)) return failure('invalid-request')
  if (Schema.is(CheckoutResolverError)(error))
    return failure(
      error.code === 'filesystem-unavailable' || error.code === 'git-unavailable' ? 'unavailable' : 'invalid-request',
    )
  return failure('failed')
}
function safe<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, WorkspaceRpcError, R> {
  return effect.pipe(
    Effect.catchCause(cause => {
      const found = Cause.findError(cause)
      return Effect.fail(found._tag === 'Success' ? sanitize(found.success) : failure('failed'))
    }),
  )
}
const timestamp = Effect.map(DateTime.now, DateTime.formatIso)
function entityId(kind: string, commandId: string): string {
  // JSON escapes lone surrogates, which UTF-8 encoding would collapse into one replacement character.
  return `${kind}-${createHash('sha256').update(JSON.stringify(commandId)).digest('hex')}`
}
const EVENT_PAGE_LIMIT = 100
const EVENT_FRAME_CAPACITY = 8
const MAX_FRAME_BYTES = Store.WORKSPACE_STORE_READ_BYTE_CAPACITY + 1024
const MAX_PENDING_BYTES = 2 * MAX_FRAME_BYTES

/** Build in the application runtime, with WorkspaceHost and WorkspaceProjects.
 * Streams own only their bounded reader fiber, never the application's execution scope.
 */
export function workspaceHandlers() {
  return Layer.unwrap(
    Effect.gen(function* () {
      const host = yield* WorkspaceHost
      const projects = yield* WorkspaceProjects
      const store = host.store
      const read = <A, E, R>(use: () => Effect.Effect<A, E, R>) =>
        safe(Effect.andThen(host.ensureOpen, Effect.suspend(use)))
      const mutation = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.uninterruptible(read(() => effect))
      const timedMutation = <A, E, R>(use: (issuedAt: string) => Effect.Effect<A, E, R>) =>
        mutation(Effect.flatMap(timestamp, use))
      const begin = Effect.fnUntraced(function* (request: Schema.Schema.Type<typeof workspaceStartRunRequestSchema>) {
        return {
          ...request,
          issuedAt: yield* timestamp,
          runId: Schema.decodeUnknownSync(agentRunIdSchema)(entityId('run', request.commandId)),
          provisionalAgentSessionId: entityId('session', request.commandId),
        }
      })

      return WorkspaceRpcGroup.toLayer({
        'workspace:status': () =>
          safe(
            Effect.gen(function* () {
              const status = yield* SubscriptionRef.get(host.status)
              return {
                protocolVersion: WORKSPACE_RPC_PROTOCOL_VERSION,
                ...status,
                ownerEpoch: status.ownerEpoch ?? null,
                highWatermark: yield* SubscriptionRef.get(host.eventHighWatermark),
              }
            }),
          ),
        'workspace:listConnections': () =>
          safe(Effect.map(host.listConnections ?? Effect.succeed([]), items => ({ items }))),
        'workspace:registerProject': request =>
          mutation(
            Effect.gen(function* () {
              const projectId = Schema.decodeUnknownSync(projectIdSchema)(entityId('project', request.commandId))
              const checkoutId = Schema.decodeUnknownSync(workspaceCheckoutIdSchema)(
                entityId('checkout', request.commandId),
              )
              return yield* projects.register({
                commandId: request.commandId,
                projectId,
                checkoutId,
                name: request.name,
                path: request.path,
              })
            }),
          ),
        'workspace:createTask': request =>
          mutation(
            Effect.gen(function* () {
              const taskId = Schema.decodeUnknownSync(taskIdSchema)(entityId('task', request.commandId))
              const conversationId = Schema.decodeUnknownSync(conversationIdSchema)(
                entityId('conversation', request.commandId),
              )
              const at = yield* timestamp
              return yield* store.createTask({
                commandId: request.commandId,
                task: {
                  id: taskId,
                  projectId: request.projectId,
                  title: request.title,
                  description: request.description,
                  createdAt: at,
                },
                conversation: { id: conversationId, createdAt: at },
              })
            }),
          ),
        'workspace:listProjects': ({ options }) => read(() => store.listProjects(options)),
        'workspace:getProject': ({ projectId, options }) => read(() => store.getProject(projectId, options)),
        'workspace:listTasks': ({ projectId, options }) => read(() => store.listTasks(projectId, options)),
        'workspace:readTaskDetail': ({ taskId, options }) => read(() => store.readTaskDetail(taskId, options)),
        'workspace:readConversationPage': request =>
          read(() =>
            store.readConversationPage(
              request.conversationId,
              request.afterSequence,
              request.limit,
              request.throughSequence,
            ),
          ),
        'workspace:listPendingRuntimeRequests': request =>
          read(() => store.listPendingRuntimeRequests(request.taskId, request.afterSequence, request.limit)),
        'workspace:readWorkspacePayload': request =>
          read(() => store.readWorkspacePayload(request.reference, request.afterOffset, request.limit)),
        'workspace:listQueuedFollowUps': ({ conversationId, options }) =>
          read(() => store.listQueuedFollowUps(conversationId, options)),
        'workspace:listRequestResponses': ({ taskId, options }) =>
          read(() => store.listRequestResponses(taskId, options)),
        'workspace:listSteerIntents': ({ taskId, options }) => read(() => store.listSteerIntents(taskId, options)),
        'workspace:startRun': request =>
          mutation(
            Effect.gen(function* () {
              const command = yield* begin(request)
              return yield* host.withExecution(execution => execution.start(command))
            }),
          ),
        'workspace:interrupt': request =>
          mutation(
            Effect.gen(function* () {
              yield* host.withExecution(execution => execution.interrupt(request.runId))
              return { ...request, outcome: 'interruptRequested' as const }
            }),
          ),
        'workspace:respond': request =>
          timedMutation(issuedAt =>
            host.withExecution((execution, ownerEpoch) => execution.respond({ ...request, ownerEpoch, issuedAt })),
          ),
        'workspace:steer': request =>
          timedMutation(issuedAt =>
            host.withExecution((execution, ownerEpoch) => execution.steer({ ...request, ownerEpoch, issuedAt })),
          ),
        'workspace:enqueueFollowUp': request =>
          timedMutation(issuedAt =>
            host.withExecution(execution => execution.enqueueFollowUp({ ...request, issuedAt })),
          ),
        'workspace:cancelQueuedFollowUp': request =>
          mutation(
            Effect.gen(function* () {
              yield* host.withExecution(execution =>
                execution.cancelQueuedFollowUp(request.conversationId, request.targetCommandId),
              )
              return {
                commandId: request.commandId,
                targetCommandId: request.targetCommandId,
                outcome: 'removed' as const,
              }
            }),
          ),
        'workspace:promoteQueuedFollowUp': request =>
          mutation(
            Effect.gen(function* () {
              const command = yield* begin(request)
              return yield* host.withExecution(execution =>
                execution.promoteQueuedFollowUp(request.conversationId, command),
              )
            }),
          ),
        'workspace:events': ({ afterSequence }) =>
          Stream.unwrap(
            Effect.gen(function* () {
              yield* read(() => Effect.void)
              const queue = yield* Queue.bounded<{ frame: WorkspaceEventFrame; bytes: number }, WorkspaceRpcError>(
                EVENT_FRAME_CAPACITY,
              )
              let pendingBytes = 0
              let cursor = afterSequence
              const publish = Effect.fnUntraced(function* (frame: WorkspaceEventFrame) {
                const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8')
                if (
                  bytes > MAX_FRAME_BYTES ||
                  pendingBytes + bytes > MAX_PENDING_BYTES ||
                  !Queue.offerUnsafe(queue, { frame, bytes })
                )
                  return yield* failure('stream-overflow')
                pendingBytes += bytes
              })
              const drain = Effect.fnUntraced(function* (_tag: WorkspaceEventFrame['_tag'], throughSequence: number) {
                do {
                  const page = yield* safe(store.pageEvents(cursor, EVENT_PAGE_LIMIT, throughSequence))
                  yield* publish({ protocolVersion: WORKSPACE_RPC_PROTOCOL_VERSION, _tag, throughSequence, page })
                  const last = page.events.at(-1)?.sequence
                  if (!page.hasMore) {
                    cursor = throughSequence
                    break
                  }
                  if (last === undefined || last <= cursor) return yield* failure('failed')
                  cursor = last
                } while (cursor < throughSequence)
              })
              // Watermarks are wake-ups, not events; coalescing them is lossless because pages use durable cursors.
              const watermarks = yield* Queue.sliding<number>(1)
              yield* Effect.forkScoped(
                Stream.runForEach(SubscriptionRef.changes(host.eventHighWatermark), high =>
                  Queue.offer(watermarks, high),
                ),
              )
              yield* Effect.forkScoped(
                Effect.gen(function* () {
                  const initial = yield* safe(store.pageEvents(afterSequence, 1))
                  if (afterSequence > initial.highWatermark) return yield* failure('stale')
                  yield* drain('Snapshot', initial.highWatermark)
                  yield* Stream.runForEach(Stream.fromQueue(watermarks), high =>
                    high > cursor ? drain('Events', high) : Effect.void,
                  )
                }).pipe(Effect.catchCause(cause => Queue.fail(queue, sanitize(Cause.squash(cause))))),
              )
              return Stream.fromEffectRepeat(Queue.take(queue)).pipe(
                Stream.map(({ frame, bytes }) => {
                  pendingBytes -= bytes
                  return frame
                }),
              )
            }),
          ),
      })
    }),
  )
}
