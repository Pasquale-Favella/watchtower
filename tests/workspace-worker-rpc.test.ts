import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import { describe, expect, it, vi } from 'vitest'

import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import { WorkspaceStoreLive } from '@/infrastructure/sqlite/workspace/workspace-store.js'
import { workspaceWorkerRpcServerLayer } from '@/platform/electron/workers/workspace/rpc-server.js'
import {
  WORKSPACE_WORKER_REQUEST_BYTE_CAPACITY,
  WORKSPACE_WORKER_RESPONSE_BYTE_CAPACITY,
  WorkspaceWorkerRpcGroup,
} from '@/shared/rpc/workspace-worker.js'
import type { BeginRunCommand } from '@/shared/schemas/workspace-store.js'

const project = {
  id: 'project-1' as never,
  name: 'Project',
  repositoryIdentity: 'repo:one',
  createdAt: '2026-10-29T10:00:00Z',
  updatedAt: '2026-10-29T10:00:00Z',
}
const checkout = { id: 'checkout-1' as never, kind: 'main' as const, path: 'C:/repo', createdAt: project.createdAt }
const task = {
  id: 'task-1' as never,
  projectId: project.id,
  title: 'Task',
  description: '',
  createdAt: project.createdAt,
}
const conversation = { id: 'conversation-1' as never, title: 'Conversation', createdAt: project.createdAt }
const command: BeginRunCommand = {
  commandId: 'command-1',
  issuedAt: '2026-10-29T10:00:01Z',
  runId: 'run-1' as never,
  taskId: task.id,
  conversationId: conversation.id,
  checkoutId: checkout.id,
  provisionalAgentSessionId: 'session-1',
  generation: 1,
  driverId: 'codex',
  connectionId: 'connection-1',
  prompt: 'Fix the bug',
}

const withWorkspaceStore = <A, E, R>(
  use: (store: WorkspaceStore['Service'], sqlScope: Scope.Closeable) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const rootScope = yield* Effect.scope
      const sqlScope = yield* Scope.fork(rootScope)
      const storeContext = yield* Layer.buildWithScope(WorkspaceStoreLive({ filename: ':memory:' }), sqlScope)
      return yield* use(Context.get(storeContext, WorkspaceStore), sqlScope)
    }),
  )

describe('workspace worker RPC server', () => {
  it('round-trips durable delivery intents and follow-up queue operations', async () => {
    const result = await Effect.runPromise(
      withWorkspaceStore((store, sqlScope) => {
        const handlers = workspaceWorkerRpcServerLayer({ store, onShutdown: Scope.close(sqlScope, Exit.void) })
        return Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(WorkspaceWorkerRpcGroup)
          yield* client['workspace-worker:registerProject']({ project, mainCheckout: checkout })
          yield* client['workspace-worker:createTask']({ task, conversation })
          const queued = {
            commandId: 'queue',
            taskId: task.id,
            conversationId: conversation.id,
            prompt: 'Queued',
            issuedAt: command.issuedAt,
          }
          yield* client['workspace-worker:enqueueFollowUp'](queued)
          const listed = yield* client['workspace-worker:listQueuedFollowUps']({ conversationId: conversation.id })
          yield* client['workspace-worker:cancelQueuedFollowUp']({
            conversationId: conversation.id,
            commandId: queued.commandId,
          })
          const canceled = yield* client['workspace-worker:listQueuedFollowUps']({ conversationId: conversation.id })
          yield* client['workspace-worker:enqueueFollowUp']({ ...queued, commandId: 'queue-2' })
          const promoted = yield* client['workspace-worker:promoteNextFollowUp']({
            conversationId: conversation.id,
            command,
          })
          yield* client['workspace-worker:claimDispatch']({
            runId: command.runId,
            ownerEpoch: 7,
            claimedAt: command.issuedAt,
          })
          yield* client['workspace-worker:bindNativeSession']({
            runId: command.runId,
            binding: {
              ownerEpoch: 7,
              nativeSessionId: 'native',
              generation: 1,
              recordedAt: command.issuedAt,
            },
          })
          yield* client['workspace-worker:acknowledgeDispatch']({
            runId: command.runId,
            acknowledgement: { ownerEpoch: 7, nativeSessionId: 'native', acknowledgedAt: command.issuedAt },
          })
          yield* client['workspace-worker:recordDriverEvent']({
            runId: command.runId,
            command: {
              ownerEpoch: 7,
              generation: 1,
              eventId: 'pending',
              occurredAt: command.issuedAt,
              event: {
                kind: 'requestPending',
                request: {
                  runId: command.runId,
                  generation: 1,
                  requestId: 'approval',
                  kind: 'approval',
                  prompt: 'Allow?',
                  questions: [],
                },
              },
            },
          })
          const response = yield* client['workspace-worker:recordRequestResponse']({
            commandId: 'respond',
            issuedAt: command.issuedAt,
            runId: command.runId,
            ownerEpoch: 7,
            generation: 1,
            requestId: 'approval',
            decision: { kind: 'approve' },
          })
          yield* client['workspace-worker:settleRequestResponse']({
            runId: command.runId,
            requestId: 'approval',
            outcome: { ownerEpoch: 7, occurredAt: command.issuedAt, outcome: 'uncertain' },
          })
          const steer = yield* client['workspace-worker:recordSteer']({
            commandId: 'steer',
            issuedAt: command.issuedAt,
            runId: command.runId,
            ownerEpoch: 7,
            generation: 1,
            message: 'Focus',
          })
          yield* client['workspace-worker:settleSteer']({
            runId: command.runId,
            commandId: 'steer',
            outcome: {
              ownerEpoch: 7,
              occurredAt: command.issuedAt,
              outcome: 'accepted',
              nativeConfirmation: 'confirmed',
            },
          })
          const snapshot = yield* client['workspace-worker:readTaskSnapshot']({ taskId: task.id, runLimit: 10 })
          const responseHistory = yield* client['workspace-worker:listRequestResponses']({
            taskId: task.id,
            options: { limit: 1 },
          })
          const steerHistory = yield* client['workspace-worker:listSteerIntents']({
            taskId: task.id,
            options: { limit: 1 },
          })
          return { listed, canceled, promoted, response, steer, snapshot, responseHistory, steerHistory }
        }).pipe(Effect.provide(handlers))
      }),
    )
    expect(result.listed.items).toMatchObject([{ prompt: 'Queued' }])
    expect(result.canceled.items).toEqual([])
    expect(result.promoted?.receipt).toMatchObject({ runId: command.runId, replayed: false })
    expect(result.response).toMatchObject({ commandId: 'respond', replayed: false })
    expect(result.steer).toMatchObject({ commandId: 'steer', replayed: false })
    expect(result.responseHistory).toMatchObject({
      total: 1,
      truncated: false,
      items: [{ commandId: 'respond', state: 'uncertain' }],
    })
    expect(result.steerHistory).toMatchObject({
      total: 1,
      truncated: false,
      items: [{ commandId: 'steer', state: 'accepted' }],
    })
    expect(result.snapshot.requestResponses).toMatchObject([{ state: 'uncertain' }])
    expect(result.snapshot.steerIntents).toMatchObject([
      { state: 'accepted', delivery: { nativeConfirmation: 'confirmed' } },
    ])
  })

  it('routes every frozen operation through the SQLite store and closes SQL before shutdown ACK', async () => {
    const result = await Effect.runPromise(
      withWorkspaceStore((store, sqlScope) => {
        const handlers = workspaceWorkerRpcServerLayer({ store, onShutdown: Scope.close(sqlScope, Exit.void) })
        const program = Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(WorkspaceWorkerRpcGroup)
          const ready = yield* client['workspace-worker:ready']()
          yield* client['workspace-worker:registerProject']({ project, mainCheckout: checkout })
          yield* client['workspace-worker:createTask']({ task, conversation })
          const receipt = yield* client['workspace-worker:beginRun'](command)
          const claim = yield* client['workspace-worker:claimDispatch']({
            runId: command.runId,
            ownerEpoch: 7,
            claimedAt: '2026-10-29T10:00:02Z',
          })
          yield* client['workspace-worker:acknowledgeDispatch']({
            runId: command.runId,
            acknowledgement: {
              ownerEpoch: 7,
              nativeSessionId: 'native-session-1',
              nativeTurnId: 'native-turn-1',
              acknowledgedAt: '2026-10-29T10:00:03Z',
            },
          })
          yield* client['workspace-worker:requestInterrupt']({
            runId: command.runId,
            ownerEpoch: 7,
            requestedAt: '2026-10-29T10:00:04Z',
          })
          const event = yield* client['workspace-worker:recordDriverEvent']({
            runId: command.runId,
            command: {
              ownerEpoch: 7,
              generation: 1,
              eventId: 'event-1',
              occurredAt: '2026-10-29T10:00:05Z',
              event: { kind: 'turnInterrupted', nativeTurnId: 'native-turn-1' },
            },
          })
          const page = yield* client['workspace-worker:pageEvents']({ afterSequence: 0, limit: 500 })
          const firstSnapshot = yield* client['workspace-worker:readTaskSnapshot']({ taskId: task.id, runLimit: 10 })
          const retry: BeginRunCommand = {
            ...command,
            commandId: 'command-2',
            runId: 'run-2' as never,
            provisionalAgentSessionId: 'session-2',
            issuedAt: '2026-10-29T10:00:06Z',
            retryOfRunId: command.runId,
          }
          yield* client['workspace-worker:beginRun'](retry)
          yield* client['workspace-worker:failDispatch']({
            runId: retry.runId,
            command: {
              ownerEpoch: 7,
              occurredAt: '2026-10-29T10:00:07Z',
              outcome: 'failed',
              reason: 'launch-failed',
            },
          })
          const recovered = yield* client['workspace-worker:recoverWorker']({
            replacedEpoch: 7,
            recoveredAt: '2026-10-29T10:00:08Z',
          })
          yield* client['workspace-worker:shutdown']()
          return {
            ready,
            receipt,
            claim,
            event,
            page,
            firstSnapshot,
            recovered,
            sqlClosedAtAck: sqlScope.state._tag === 'Closed',
          }
        })
        return program.pipe(Effect.provide(handlers))
      }),
    )

    expect(result.ready).toEqual({ protocolVersion: 5 })
    expect(result.receipt).toMatchObject({ commandId: command.commandId, runId: command.runId, replayed: false })
    expect(result.claim).toMatchObject({ runId: command.runId, ownerEpoch: 7, workspacePath: checkout.path })
    expect(result.event).toMatchObject({ kind: 'driverEvent', runId: command.runId })
    expect(result.page.events.length).toBeGreaterThan(0)
    expect(result.firstSnapshot.runs[0]).toMatchObject({ id: command.runId, status: 'interrupted' })
    expect(result.recovered).toBe(0)
    expect(result.sqlClosedAtAck).toBe(true)
  })

  it('validates input and bounds both directions while returning fixed sanitized errors', async () => {
    const secret = 'SQLITE_ERROR C:\\Users\\private\\workspace.db prompt=do-not-return'
    const result = await Effect.runPromise(
      withWorkspaceStore((baseStore, sqlScope) => {
        const beginRun = vi.fn<WorkspaceStore['Service']['beginRun']>(() => Effect.die(new Error(secret)))
        const largePage = {
          events: [
            {
              sequence: 1,
              schemaVersion: 1 as const,
              kind: 'driverEvent' as const,
              runId: command.runId,
              taskId: command.taskId,
              generation: 1,
              occurredAt: command.issuedAt,
              data: { detail: 'x'.repeat(WORKSPACE_WORKER_RESPONSE_BYTE_CAPACITY + 1) },
            },
          ],
          highWatermark: 1,
        }
        const pageEvents = vi.fn<WorkspaceStore['Service']['pageEvents']>(() => Effect.succeed(largePage))
        const store = WorkspaceStore.of({ ...baseStore, beginRun, pageEvents })
        const handlers = workspaceWorkerRpcServerLayer({ store, onShutdown: Scope.close(sqlScope, Exit.void) })
        const program = Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(WorkspaceWorkerRpcGroup)
          const beginRunRpc = WorkspaceWorkerRpcGroup.requests.get('workspace-worker:beginRun')
          if (!beginRunRpc) throw new Error('workspace-worker:beginRun contract is missing')
          const invalid = Schema.decodeUnknownResult(beginRunRpc.payloadSchema)({ ...command, generation: 0 })
          const oversized = yield* Effect.exit(
            client['workspace-worker:beginRun']({
              ...command,
              commandId: 'oversized',
              prompt: 'x'.repeat(WORKSPACE_WORKER_REQUEST_BYTE_CAPACITY + 1),
            }),
          )
          const failed = yield* Effect.exit(client['workspace-worker:beginRun'](command))
          const oversizedResponse = yield* Effect.exit(
            client['workspace-worker:pageEvents']({ afterSequence: 0, limit: 1 }),
          )
          return {
            invalidPayloadRejected: invalid._tag === 'Failure',
            oversized,
            failed,
            oversizedResponse,
            beginRunCalls: beginRun.mock.calls.length,
            pageEventsCalls: pageEvents.mock.calls.length,
          }
        })
        return program.pipe(Effect.provide(handlers))
      }),
    )

    expect(result.invalidPayloadRejected).toBe(true)
    expect(result.oversized._tag).toBe('Failure')
    if (Exit.isFailure(result.oversized)) {
      expect(Cause.findError(result.oversized.cause)).toMatchObject({
        _tag: 'Success',
        success: { _tag: 'WorkspaceStoreError', code: 'invalid-data', message: 'Workspace operation data is invalid.' },
      })
    }
    expect(result.failed._tag).toBe('Failure')
    expect(result.oversizedResponse._tag).toBe('Failure')
    expect(result.beginRunCalls).toBe(1)
    expect(result.pageEventsCalls).toBe(1)
    if (Exit.isFailure(result.failed)) {
      const error = Cause.findError(result.failed.cause)
      expect(error).toMatchObject({
        _tag: 'Success',
        success: {
          _tag: 'WorkspaceStoreError',
          code: 'database-unavailable',
          message: 'Workspace database operation failed.',
        },
      })
      expect(JSON.stringify(error)).not.toContain(secret)
    }
    expect(JSON.stringify(result.oversizedResponse)).not.toContain('x'.repeat(100))
  })

  it('keeps admitted mutations alive after cancellation and drains active work before shutdown', async () => {
    const outcome = await Effect.runPromise(
      withWorkspaceStore((baseStore, sqlScope) =>
        Effect.gen(function* () {
          const mutationStarted = yield* Deferred.make<undefined>()
          const releaseMutation = yield* Deferred.make<undefined>()
          const mutationFinished = yield* Deferred.make<undefined>()
          const readStarted = yield* Deferred.make<undefined>()
          const releaseRead = yield* Deferred.make<undefined>()
          let sqlClosed = false

          const store = WorkspaceStore.of({
            ...baseStore,
            beginRun: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(mutationStarted, undefined)
                yield* Deferred.await(releaseMutation)
                yield* Deferred.succeed(mutationFinished, undefined)
                return {
                  commandId: command.commandId,
                  runId: command.runId,
                  acceptedAt: command.issuedAt,
                  replayed: false,
                }
              }),
            pageEvents: () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(readStarted, undefined)
                yield* Deferred.await(releaseRead)
                return { events: [], highWatermark: 0 }
              }),
          })
          const handlers = workspaceWorkerRpcServerLayer({
            store,
            onShutdown: Effect.sync(() => (sqlClosed = true)).pipe(Effect.andThen(Scope.close(sqlScope, Exit.void))),
          })
          const client = yield* RpcTest.makeClient(WorkspaceWorkerRpcGroup).pipe(Effect.provide(handlers))

          const mutation = yield* Effect.forkChild(client['workspace-worker:beginRun'](command))
          yield* Deferred.await(mutationStarted)
          yield* Fiber.interrupt(mutation)
          const finishedBeforeRelease = yield* Deferred.isDone(mutationFinished)
          yield* Deferred.succeed(releaseMutation, undefined)
          yield* Deferred.await(mutationFinished)

          const read = yield* Effect.forkChild(client['workspace-worker:pageEvents']({ afterSequence: 0, limit: 1 }))
          yield* Deferred.await(readStarted)
          const shutdown = yield* Effect.forkChild(client['workspace-worker:shutdown']())
          yield* Effect.sleep('10 millis')
          const closedBeforeReadDrained = sqlClosed
          const rejectedAfterShutdown = yield* Effect.exit(client['workspace-worker:ready']())
          yield* Deferred.succeed(releaseRead, undefined)
          yield* Fiber.join(read)
          yield* Fiber.join(shutdown)
          return { finishedBeforeRelease, closedBeforeReadDrained, rejectedAfterShutdown, sqlClosed }
        }),
      ),
    )

    expect(outcome.finishedBeforeRelease).toBe(false)
    expect(outcome.closedBeforeReadDrained).toBe(false)
    expect(outcome.rejectedAfterShutdown._tag).toBe('Failure')
    expect(outcome.sqlClosed).toBe(true)
  })
})
