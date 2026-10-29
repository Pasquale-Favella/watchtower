import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import { Rpc, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'

import { WorkspaceStore } from '@/core/ports/workspace-store.js'
import {
  WORKSPACE_WORKER_REQUEST_BYTE_CAPACITY,
  WORKSPACE_WORKER_REQUEST_CAPACITY,
  WORKSPACE_WORKER_RESPONSE_BYTE_CAPACITY,
  WORKSPACE_WORKER_PROTOCOL_VERSION,
  WorkspaceWorkerRpcGroup,
} from '@/shared/rpc/workspace-worker.js'
import { WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

type WorkspaceRpcDefinition = RpcGroup.Rpcs<typeof WorkspaceWorkerRpcGroup>
type WorkspaceRpcTag = WorkspaceRpcDefinition['_tag']
type WorkspaceRpcSuccess<Tag extends WorkspaceRpcTag> = Rpc.Success<
  Extract<WorkspaceRpcDefinition, { readonly _tag: Tag }>
>

const safeMessages = {
  'not-found': 'Workspace record was not found.',
  'membership-conflict': 'Workspace operation conflicts with stored membership.',
  'command-conflict': 'Workspace command conflicts with a prior operation.',
  'admission-conflict': 'Workspace operation is not currently admissible.',
  'stale-epoch': 'Workspace worker epoch is stale.',
  'invalid-transition': 'Workspace state transition is invalid.',
  'invalid-data': 'Workspace operation data is invalid.',
  'database-unavailable': 'Workspace database operation failed.',
} satisfies Record<WorkspaceStoreError['code'], string>

const safeError = (code: WorkspaceStoreError['code']): WorkspaceStoreError =>
  new WorkspaceStoreError({ code, message: safeMessages[code] })

const sanitizeError = (error: unknown): WorkspaceStoreError =>
  error instanceof WorkspaceStoreError ? safeError(error.code) : safeError('database-unavailable')

const byteLength = (value: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

export interface WorkspaceWorkerRpcServerOptions {
  readonly store: WorkspaceStore['Service']
  readonly onShutdown: Effect.Effect<void, unknown>
}

interface WorkspaceWorkerRpcStateService {
  readonly execute: <Tag extends WorkspaceRpcTag>(
    tag: Tag,
    payload: unknown,
    operation: () => Effect.Effect<WorkspaceRpcSuccess<Tag>, unknown>,
    mutation?: boolean,
  ) => Effect.Effect<WorkspaceRpcSuccess<Tag>, WorkspaceStoreError>
  readonly shutdown: () => Effect.Effect<void, WorkspaceStoreError>
}

class WorkspaceWorkerRpcState extends Context.Service<WorkspaceWorkerRpcState, WorkspaceWorkerRpcStateService>()(
  'watchtower/platform/WorkspaceWorkerRpcState',
) {}

export function workspaceWorkerRpcServerLayer(options: WorkspaceWorkerRpcServerOptions) {
  const stateLayer = Layer.effect(
    WorkspaceWorkerRpcState,
    Effect.gen(function* () {
      const drained = yield* Deferred.make<undefined>()
      const shutdownResult = yield* Deferred.make<Exit.Exit<void, WorkspaceStoreError>>()
      let activeRequests = 0
      let closing = false

      const execute = <Tag extends WorkspaceRpcTag>(
        tag: Tag,
        payload: unknown,
        operation: () => Effect.Effect<WorkspaceRpcSuccess<Tag>, unknown>,
        mutation = false,
      ): Effect.Effect<WorkspaceRpcSuccess<Tag>, WorkspaceStoreError> =>
        Effect.suspend((): Effect.Effect<WorkspaceRpcSuccess<Tag>, WorkspaceStoreError> => {
          if (byteLength(payload) > WORKSPACE_WORKER_REQUEST_BYTE_CAPACITY) {
            return Effect.fail(safeError('invalid-data'))
          }

          const rpc = WorkspaceWorkerRpcGroup.requests.get(tag)
          if (!rpc || Schema.decodeUnknownResult(rpc.payloadSchema)(payload)._tag === 'Failure') {
            return Effect.fail(safeError('invalid-data'))
          }
          if (closing || activeRequests >= WORKSPACE_WORKER_REQUEST_CAPACITY) {
            return Effect.fail(safeError('database-unavailable'))
          }

          activeRequests += 1
          const release = Effect.suspend(() => {
            activeRequests -= 1
            return closing && activeRequests === 0
              ? Deferred.succeed(drained, undefined).pipe(Effect.asVoid)
              : Effect.void
          })

          const result = Effect.suspend(operation).pipe(
            Effect.flatMap(value => {
              const encoded = Schema.decodeUnknownResult(rpc.successSchema)(value)
              if (encoded._tag === 'Failure') return Effect.fail(safeError('database-unavailable'))
              if (byteLength(encoded.success) > WORKSPACE_WORKER_RESPONSE_BYTE_CAPACITY) {
                return Effect.fail(safeError('database-unavailable'))
              }
              return Effect.succeed(encoded.success as WorkspaceRpcSuccess<typeof tag>)
            }),
            Effect.mapError(sanitizeError),
            Effect.catchDefect(() => Effect.fail(safeError('database-unavailable'))),
            Effect.ensuring(release),
          )

          return mutation ? Effect.uninterruptible(result) : result
        }).pipe(Effect.catchDefect(() => Effect.fail(safeError('database-unavailable'))))

      const awaitShutdown = (): Effect.Effect<void, WorkspaceStoreError> =>
        Deferred.await(shutdownResult).pipe(
          Effect.flatMap(exit => (Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause))),
        )

      const shutdown = (): Effect.Effect<void, WorkspaceStoreError> =>
        Effect.suspend((): Effect.Effect<void, WorkspaceStoreError> => {
          const rpc = WorkspaceWorkerRpcGroup.requests.get('workspace-worker:shutdown')
          if (
            !rpc ||
            byteLength(undefined) > WORKSPACE_WORKER_REQUEST_BYTE_CAPACITY ||
            Schema.decodeUnknownResult(rpc.payloadSchema)(undefined)._tag === 'Failure'
          ) {
            return Effect.fail(safeError('invalid-data'))
          }

          if (closing) return awaitShutdown()
          closing = true
          const signalDrained =
            activeRequests === 0 ? Deferred.succeed(drained, undefined).pipe(Effect.asVoid) : Effect.void
          const closeExit: Effect.Effect<Exit.Exit<void, WorkspaceStoreError>> = Effect.suspend(
            () => options.onShutdown,
          ).pipe(
            Effect.mapError(sanitizeError),
            Effect.catchDefect(() => Effect.fail(safeError('database-unavailable'))),
            Effect.exit,
          )
          const closeAfterDrain = signalDrained.pipe(
            Effect.andThen(Deferred.await(drained)),
            Effect.andThen(closeExit),
            Effect.flatMap(exit => Deferred.succeed(shutdownResult, exit)),
            Effect.asVoid,
            Effect.andThen(awaitShutdown()),
          )
          return Effect.uninterruptible(closeAfterDrain)
        }).pipe(Effect.catchDefect(() => Effect.fail(safeError('database-unavailable'))))

      return WorkspaceWorkerRpcState.of({ execute, shutdown })
    }),
  )

  const execute = <Tag extends WorkspaceRpcTag>(
    tag: Tag,
    payload: unknown,
    operation: () => Effect.Effect<WorkspaceRpcSuccess<Tag>, unknown>,
    mutation = false,
  ) => Effect.flatMap(WorkspaceWorkerRpcState, state => state.execute(tag, payload, operation, mutation))

  const handlers = WorkspaceWorkerRpcGroup.toLayer({
    'workspace-worker:ready': () =>
      execute('workspace-worker:ready', undefined, () =>
        Effect.succeed({ protocolVersion: WORKSPACE_WORKER_PROTOCOL_VERSION }),
      ),
    'workspace-worker:registerProject': command =>
      execute('workspace-worker:registerProject', command, () => options.store.registerProject(command), true),
    'workspace-worker:createTask': command =>
      execute('workspace-worker:createTask', command, () => options.store.createTask(command), true),
    'workspace-worker:beginRun': command =>
      execute('workspace-worker:beginRun', command, () => options.store.beginRun(command), true),
    'workspace-worker:claimDispatch': ({ runId, ownerEpoch, claimedAt }) =>
      execute(
        'workspace-worker:claimDispatch',
        { runId, ownerEpoch, claimedAt },
        () => options.store.claimDispatch(runId, ownerEpoch, claimedAt),
        true,
      ),
    'workspace-worker:acknowledgeDispatch': ({ runId, acknowledgement }) =>
      execute(
        'workspace-worker:acknowledgeDispatch',
        { runId, acknowledgement },
        () => options.store.acknowledgeDispatch(runId, acknowledgement),
        true,
      ),
    'workspace-worker:recordDriverEvent': ({ runId, command }) =>
      execute(
        'workspace-worker:recordDriverEvent',
        { runId, command },
        () => options.store.recordDriverEvent(runId, command),
        true,
      ),
    'workspace-worker:failDispatch': ({ runId, command }) =>
      execute(
        'workspace-worker:failDispatch',
        { runId, command },
        () => options.store.failDispatch(runId, command),
        true,
      ),
    'workspace-worker:requestInterrupt': ({ runId, ownerEpoch, requestedAt }) =>
      execute(
        'workspace-worker:requestInterrupt',
        { runId, ownerEpoch, requestedAt },
        () => options.store.requestInterrupt(runId, ownerEpoch, requestedAt),
        true,
      ),
    'workspace-worker:recoverWorker': ({ replacedEpoch, recoveredAt }) =>
      execute(
        'workspace-worker:recoverWorker',
        { replacedEpoch, recoveredAt },
        () => options.store.recoverWorker(replacedEpoch, recoveredAt),
        true,
      ),
    'workspace-worker:pageEvents': ({ afterSequence, limit }) =>
      execute('workspace-worker:pageEvents', { afterSequence, limit }, () =>
        options.store.pageEvents(afterSequence, limit),
      ),
    'workspace-worker:readTaskSnapshot': ({ taskId, runLimit }) =>
      execute('workspace-worker:readTaskSnapshot', { taskId, runLimit }, () =>
        options.store.readTaskSnapshot(taskId, runLimit),
      ),
    'workspace-worker:shutdown': () => Effect.flatMap(WorkspaceWorkerRpcState, state => state.shutdown()),
  })

  return handlers.pipe(Layer.provide(stateLayer))
}
