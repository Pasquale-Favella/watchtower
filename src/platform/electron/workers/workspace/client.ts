import { Buffer } from 'node:buffer'
import { isAbsolute } from 'node:path'
import { Worker } from 'node:worker_threads'

import * as NodeWorkerPlatform from '@effect/platform-node/NodeWorker'
import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import { RpcClient, RpcGroup, RpcWorker } from 'effect/rpc'
import type { RpcClientError } from 'effect/rpc/RpcClientError'
import * as Schema from 'effect/Schema'

import { WorkspaceStore, type NativeTurnAcknowledgement } from '@/core/ports/workspace-store.js'
import {
  WORKSPACE_WORKER_REQUEST_BYTE_CAPACITY,
  WORKSPACE_WORKER_REQUEST_CAPACITY,
  WORKSPACE_WORKER_RESPONSE_BYTE_CAPACITY,
  WorkspaceWorkerRpcGroup,
} from '@/shared/rpc/workspace-worker.js'
import type {
  BeginRunCommand,
  CreateTaskCommand,
  DispatchFailureCommand,
  RecordDriverEventCommand,
  WorkspaceEventPage,
  WorkspaceSnapshot,
} from '@/shared/schemas/workspace-store.js'
import { WorkspaceStoreError } from '@/shared/schemas/workspace-store.js'

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 5_000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_CLOSE_TIMEOUT_MS = 3_000
const NATIVE_WORKER_TERMINATION_BUDGET_MS = 250
const TRANSPORT_FAILURE_MESSAGE = 'Workspace storage is unavailable.'
const CLEANUP_FAILURE_MESSAGE = 'Workspace worker cleanup did not complete.'
const REQUEST_LIMIT_MESSAGE = 'Workspace worker request limit exceeded.'
const RESPONSE_LIMIT_MESSAGE = 'Workspace worker response limit exceeded.'
const INVALID_REQUEST_MESSAGE = 'Workspace worker request is invalid.'

type WorkspaceWorkerRpcClient = RpcClient.FromGroup<typeof WorkspaceWorkerRpcGroup, RpcClientError>
type WorkspaceWorkerRpcDefinition = RpcGroup.Rpcs<typeof WorkspaceWorkerRpcGroup>
type WorkspaceWorkerRpcTag = WorkspaceWorkerRpcDefinition['_tag']

export interface WorkspaceWorkerStoreOptions {
  readonly filename: string
  readonly workerPath: string | URL
  readonly workerFactory?: (workerPath: string | URL, workerData: { readonly filename: string }) => Worker
  readonly initializationTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly closeTimeoutMs?: number
}

interface DeferredPromise<A> {
  readonly promise: Promise<A>
  readonly resolve: (value: A) => void
  readonly reject: (cause: unknown) => void
}

interface OpenWorkspaceWorker {
  readonly store: WorkspaceStore['Service']
  readonly close: () => Promise<void>
}

interface ReadyWorkspaceWorker {
  readonly client: WorkspaceWorkerRpcClient
  readonly fiber: Fiber.Fiber<void, unknown>
  readonly store: WorkspaceStore['Service']
}

function deferred<A>(): DeferredPromise<A> {
  let resolve!: (value: A) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<A>((done, fail) => {
    resolve = done
    reject = fail
  })
  promise.catch(() => {})
  return { promise, resolve, reject }
}

function transportFailure(): WorkspaceStoreError {
  return new WorkspaceStoreError({ code: 'database-unavailable', message: TRANSPORT_FAILURE_MESSAGE })
}

function cleanupFailure(): WorkspaceStoreError {
  return new WorkspaceStoreError({ code: 'database-unavailable', message: CLEANUP_FAILURE_MESSAGE })
}

function requestLimitFailure(): WorkspaceStoreError {
  return new WorkspaceStoreError({ code: 'database-unavailable', message: REQUEST_LIMIT_MESSAGE })
}

function responseLimitFailure(): WorkspaceStoreError {
  return new WorkspaceStoreError({ code: 'database-unavailable', message: RESPONSE_LIMIT_MESSAGE })
}

function invalidRequestFailure(): WorkspaceStoreError {
  return new WorkspaceStoreError({ code: 'invalid-data', message: INVALID_REQUEST_MESSAGE })
}

function workspaceErrorFromCause(cause: Cause.Cause<unknown>): WorkspaceStoreError {
  const error = Cause.findErrorOption(cause)
  return error._tag === 'Some' && error.value instanceof WorkspaceStoreError ? error.value : transportFailure()
}

function protocolLayer(worker: Worker) {
  let supplied = false
  return RpcClient.layerProtocolWorker({ size: 1, concurrency: WORKSPACE_WORKER_REQUEST_CAPACITY }).pipe(
    Layer.provide(
      Layer.merge(
        NodeWorkerPlatform.layer(() => {
          if (supplied) throw new Error('one protocol scope owns the supplied workspace worker')
          supplied = true
          return worker
        }),
        RpcWorker.layerInitialMessage(Schema.Void, Effect.succeed(undefined)),
      ),
    ),
  )
}

function byteLength(value: unknown): number {
  const encoded = JSON.stringify(value)
  if (encoded === undefined) return 0
  return Buffer.byteLength(encoded, 'utf8')
}

function withTimeout<A, E>(effect: Effect.Effect<A, E>, timeoutMs: number): Effect.Effect<A, E | WorkspaceStoreError> {
  return Effect.timeoutOrElse(effect, {
    duration: Duration.millis(timeoutMs),
    orElse: () => Effect.fail(transportFailure()),
  })
}

function waitWithin<A>(
  promise: Promise<A>,
  timeoutMs: number,
): Promise<{ readonly completed: true; readonly value: A } | { readonly completed: false }> {
  if (timeoutMs <= 0) {
    promise.catch(() => {})
    return Promise.resolve({ completed: false })
  }
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ completed: false }), timeoutMs)
    promise.then(
      value => {
        clearTimeout(timer)
        resolve({ completed: true, value })
      },
      () => {
        clearTimeout(timer)
        resolve({ completed: false })
      },
    )
  })
}

async function terminateWorkerWithin(worker: Worker, timeoutMs: number): Promise<boolean> {
  if (worker.threadId === -1) return true

  let termination: Promise<number>
  try {
    termination = worker.terminate()
  } catch {
    return false
  }
  const result = await waitWithin(termination, timeoutMs)
  return result.completed && worker.threadId === -1
}

async function openWorkspaceWorker(options: WorkspaceWorkerStoreOptions): Promise<OpenWorkspaceWorker> {
  if (!isAbsolute(options.filename)) throw invalidRequestFailure()

  const initializationTimeoutMs = options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS
  if (
    !Number.isSafeInteger(initializationTimeoutMs) ||
    initializationTimeoutMs <= 0 ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs <= 0 ||
    !Number.isSafeInteger(closeTimeoutMs) ||
    closeTimeoutMs <= 0
  )
    throw invalidRequestFailure()

  const workerData = { filename: options.filename }
  const worker = options.workerFactory
    ? options.workerFactory(options.workerPath, workerData)
    : new Worker(options.workerPath, { workerData })
  const startup = deferred<ReadyWorkspaceWorker>()
  const stop = deferred<undefined>()
  const failureSignal = deferred<WorkspaceStoreError>()
  const exited = deferred<number>()

  let fiber: Fiber.Fiber<void, unknown> | null = null
  let client: WorkspaceWorkerRpcClient | null = null
  let generationFailure: WorkspaceStoreError | null = null
  let activeRequests = 0
  let idleRequests = Promise.resolve()
  let resolveIdle: (() => void) | null = null
  let closing = false
  let shutdownRequested = false
  let closePromise: Promise<void> | null = null

  const failGeneration = (error: WorkspaceStoreError): void => {
    if (generationFailure) return
    generationFailure = error
    failureSignal.resolve(error)
    if (!client) startup.reject(error)
    stop.resolve(undefined)
  }

  const onError = (): void => failGeneration(transportFailure())
  const onExit = (code: number): void => {
    exited.resolve(code)
    if (shutdownRequested && activeRequests === 0) return
    failGeneration(transportFailure())
  }

  worker.on('error', onError)
  worker.on('exit', onExit)

  const awaitFailure = Effect.flatMap(
    Effect.promise(() => failureSignal.promise),
    error => Effect.fail(error),
  )
  const program = Effect.scoped(
    Effect.gen(function* () {
      const protocol = yield* Layer.build(protocolLayer(worker))
      const rawClient = yield* RpcClient.make(WorkspaceWorkerRpcGroup).pipe(
        Effect.provideService(RpcClient.Protocol, Context.get(protocol, RpcClient.Protocol)),
      )
      client = rawClient

      yield* withTimeout(rawClient['workspace-worker:ready'](undefined), initializationTimeoutMs)

      const invoke = <A>(
        tag: WorkspaceWorkerRpcTag,
        payload: unknown,
        operation: () => Effect.Effect<A, unknown>,
      ): Effect.Effect<A, WorkspaceStoreError> =>
        Effect.suspend(() => {
          if (closing || generationFailure || worker.threadId === -1)
            return Effect.fail(generationFailure ?? transportFailure())

          const rpc = WorkspaceWorkerRpcGroup.requests.get(tag)
          if (!rpc || Schema.decodeUnknownResult(rpc.payloadSchema)(payload)._tag === 'Failure')
            return Effect.fail(invalidRequestFailure())

          let bytes: number
          try {
            bytes = byteLength(payload)
          } catch {
            return Effect.fail(invalidRequestFailure())
          }
          if (bytes > WORKSPACE_WORKER_REQUEST_BYTE_CAPACITY) return Effect.fail(requestLimitFailure())
          if (activeRequests >= WORKSPACE_WORKER_REQUEST_CAPACITY) return Effect.fail(requestLimitFailure())

          if (activeRequests === 0) {
            idleRequests = new Promise<void>(resolve => {
              resolveIdle = resolve
            })
          }
          activeRequests += 1

          const call = Effect.raceFirst(operation(), awaitFailure).pipe(
            Effect.flatMap(result => {
              if (generationFailure || worker.threadId === -1)
                return Effect.fail(generationFailure ?? transportFailure())
              try {
                if (byteLength(result) > WORKSPACE_WORKER_RESPONSE_BYTE_CAPACITY)
                  return Effect.fail(responseLimitFailure())
              } catch {
                return Effect.fail(responseLimitFailure())
              }
              return Effect.succeed(result)
            }),
            Effect.catchCause(cause =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.fail(generationFailure ?? workspaceErrorFromCause(cause)),
            ),
          )

          return withTimeout(call, requestTimeoutMs).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                activeRequests -= 1
                if (activeRequests === 0) {
                  resolveIdle?.()
                  resolveIdle = null
                }
              }),
            ),
          )
        })

      const store: WorkspaceStore['Service'] = {
        registerProject: command =>
          invoke('workspace-worker:registerProject', command, () =>
            rawClient['workspace-worker:registerProject'](command),
          ),
        createTask: (command: CreateTaskCommand) =>
          invoke('workspace-worker:createTask', command, () => rawClient['workspace-worker:createTask'](command)),
        beginRun: (command: BeginRunCommand) =>
          invoke('workspace-worker:beginRun', command, () => rawClient['workspace-worker:beginRun'](command)),
        claimDispatch: (runId, ownerEpoch, claimedAt) => {
          const payload = { runId, ownerEpoch, claimedAt }
          return invoke('workspace-worker:claimDispatch', payload, () =>
            rawClient['workspace-worker:claimDispatch'](payload),
          )
        },
        bindNativeSession: (runId, binding) => {
          const payload = { runId, binding }
          return invoke('workspace-worker:bindNativeSession', payload, () =>
            rawClient['workspace-worker:bindNativeSession'](payload),
          )
        },
        acknowledgeDispatch: (runId, acknowledgement: NativeTurnAcknowledgement) => {
          const payload = { runId, acknowledgement }
          return invoke('workspace-worker:acknowledgeDispatch', payload, () =>
            rawClient['workspace-worker:acknowledgeDispatch'](payload),
          )
        },
        recordDriverEvent: (runId, command: RecordDriverEventCommand) => {
          const payload = { runId, command }
          return invoke('workspace-worker:recordDriverEvent', payload, () =>
            rawClient['workspace-worker:recordDriverEvent'](payload),
          )
        },
        failDispatch: (runId, command: DispatchFailureCommand) => {
          const payload = { runId, command }
          return invoke('workspace-worker:failDispatch', payload, () =>
            rawClient['workspace-worker:failDispatch'](payload),
          )
        },
        requestInterrupt: (runId, ownerEpoch, requestedAt) => {
          const payload = { runId, ownerEpoch, requestedAt }
          return invoke('workspace-worker:requestInterrupt', payload, () =>
            rawClient['workspace-worker:requestInterrupt'](payload),
          )
        },
        recordRequestResponse: command =>
          invoke('workspace-worker:recordRequestResponse', command, () =>
            rawClient['workspace-worker:recordRequestResponse'](command),
          ),
        settleRequestResponse: (runId, requestId, outcome) => {
          const payload = { runId, requestId, outcome }
          return invoke('workspace-worker:settleRequestResponse', payload, () =>
            rawClient['workspace-worker:settleRequestResponse'](payload),
          )
        },
        recordSteer: command =>
          invoke('workspace-worker:recordSteer', command, () => rawClient['workspace-worker:recordSteer'](command)),
        settleSteer: (runId, commandId, outcome) => {
          const payload = { runId, commandId, outcome }
          return invoke('workspace-worker:settleSteer', payload, () =>
            rawClient['workspace-worker:settleSteer'](payload),
          )
        },
        enqueueFollowUp: command =>
          invoke('workspace-worker:enqueueFollowUp', command, () =>
            rawClient['workspace-worker:enqueueFollowUp'](command),
          ),
        cancelQueuedFollowUp: (conversationId, commandId) => {
          const payload = { conversationId, commandId }
          return invoke('workspace-worker:cancelQueuedFollowUp', payload, () =>
            rawClient['workspace-worker:cancelQueuedFollowUp'](payload),
          )
        },
        listQueuedFollowUps: (conversationId, options) => {
          const payload = { conversationId, options }
          return invoke('workspace-worker:listQueuedFollowUps', payload, () =>
            rawClient['workspace-worker:listQueuedFollowUps'](payload),
          )
        },
        listRequestResponses: (taskId, options) => {
          const payload = { taskId, options }
          return invoke('workspace-worker:listRequestResponses', payload, () =>
            rawClient['workspace-worker:listRequestResponses'](payload),
          )
        },
        listSteerIntents: (taskId, options) => {
          const payload = { taskId, options }
          return invoke('workspace-worker:listSteerIntents', payload, () =>
            rawClient['workspace-worker:listSteerIntents'](payload),
          )
        },
        promoteNextFollowUp: (conversationId, command) => {
          const payload = { conversationId, command }
          return invoke('workspace-worker:promoteNextFollowUp', payload, () =>
            rawClient['workspace-worker:promoteNextFollowUp'](payload),
          )
        },
        recoverWorker: (replacedEpoch, recoveredAt) => {
          const payload = { replacedEpoch, recoveredAt }
          return invoke('workspace-worker:recoverWorker', payload, () =>
            rawClient['workspace-worker:recoverWorker'](payload),
          )
        },
        acquireOwnerEpoch: recoveredAt => {
          const payload = { recoveredAt }
          return invoke('workspace-worker:acquireOwnerEpoch', payload, () =>
            rawClient['workspace-worker:acquireOwnerEpoch'](payload),
          )
        },
        pageEvents: (afterSequence, limit): Effect.Effect<WorkspaceEventPage, WorkspaceStoreError> => {
          const payload = { afterSequence, limit }
          return invoke('workspace-worker:pageEvents', payload, () => rawClient['workspace-worker:pageEvents'](payload))
        },
        readTaskSnapshot: (taskId, runLimit): Effect.Effect<WorkspaceSnapshot, WorkspaceStoreError> => {
          const payload = { taskId, runLimit }
          return invoke('workspace-worker:readTaskSnapshot', payload, () =>
            rawClient['workspace-worker:readTaskSnapshot'](payload),
          )
        },
      }

      startup.resolve({
        client: rawClient,
        fiber: Fiber.getCurrent() as Fiber.Fiber<void, unknown>,
        store,
      })
      yield* Effect.promise(() => stop.promise).pipe(Effect.asVoid)
    }).pipe(
      Effect.catchCause(cause =>
        Effect.sync(() => failGeneration(workspaceErrorFromCause(cause))).pipe(Effect.andThen(Effect.failCause(cause))),
      ),
    ),
  )

  // Opening the worker protocol is the composition root for its scoped fiber.
  // eslint-disable-next-line watchtower-effect/no-run-outside-composition-root
  fiber = Effect.runFork(program)
  fiber.addObserver(exit => {
    worker.off('error', onError)
    worker.off('exit', onExit)
    if (exit._tag === 'Failure') {
      const error = workspaceErrorFromCause(exit.cause)
      failGeneration(error)
      startup.reject(error)
    } else if (!closing && !generationFailure) {
      const error = transportFailure()
      failGeneration(error)
      startup.reject(error)
    }
  })

  let ready: ReadyWorkspaceWorker
  const startupTimeout = setTimeout(() => startup.reject(transportFailure()), initializationTimeoutMs)
  try {
    ready = await startup.promise
  } catch (cause) {
    clearTimeout(startupTimeout)
    const cleanupDeadline = Date.now() + NATIVE_WORKER_TERMINATION_BUDGET_MS
    const terminated = await terminateWorkerWithin(worker, cleanupDeadline - Date.now())
    stop.resolve(undefined)
    let protocolClosed = true
    if (fiber) {
      // eslint-disable-next-line watchtower-effect/no-run-outside-composition-root
      const interruption = Effect.runPromise(Fiber.interrupt(fiber))
      const interrupted = await waitWithin(interruption, cleanupDeadline - Date.now())
      protocolClosed = interrupted.completed
    }
    worker.off('error', onError)
    worker.off('exit', onExit)
    if (!terminated || !protocolClosed) throw cleanupFailure()
    throw cause instanceof WorkspaceStoreError ? cause : transportFailure()
  }
  clearTimeout(startupTimeout)

  if (!client || !fiber) {
    failGeneration(transportFailure())
    throw transportFailure()
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      closing = true
      const deadline = Date.now() + closeTimeoutMs
      try {
        if (activeRequests > 0) await waitWithin(idleRequests, deadline - Date.now())

        let shutdownCompletion: Promise<void> | null = null
        const activeClient = client
        if (!generationFailure && activeClient && worker.threadId !== -1 && Date.now() < deadline) {
          shutdownRequested = true
          const shutdown = withTimeout(
            Effect.raceFirst(activeClient['workspace-worker:shutdown'](undefined), awaitFailure),
            deadline - Date.now(),
          )
          // eslint-disable-next-line watchtower-effect/no-run-outside-composition-root
          shutdownCompletion = Effect.runPromise(shutdown).then(
            () => undefined,
            () => undefined,
          )
          await waitWithin(shutdownCompletion, deadline - Date.now())
        }

        const expiredBeforeScopeClose = Date.now() >= deadline
        const cleanupDeadline = expiredBeforeScopeClose ? Date.now() + NATIVE_WORKER_TERMINATION_BUDGET_MS : null
        if (cleanupDeadline !== null) {
          const terminated = await terminateWorkerWithin(worker, cleanupDeadline - Date.now())
          if (!terminated) {
            if (!generationFailure && activeRequests > 0) failGeneration(transportFailure())
            else stop.resolve(undefined)
            throw cleanupFailure()
          }
        }

        if (!generationFailure && activeRequests > 0) failGeneration(transportFailure())
        stop.resolve(undefined)

        // eslint-disable-next-line watchtower-effect/no-run-outside-composition-root
        const protocolCompletion = fiber ? Effect.runPromise(Fiber.await(fiber)) : Promise.resolve(undefined)
        let needsForce = expiredBeforeScopeClose
        if (!needsForce && fiber) {
          const joined = await waitWithin(protocolCompletion, deadline - Date.now())
          needsForce = !joined.completed
        }
        if (!needsForce && worker.threadId !== -1) {
          const gracefulExit = await waitWithin(exited.promise, deadline - Date.now())
          needsForce = !gracefulExit.completed && worker.threadId !== -1
        }

        if (needsForce || worker.threadId !== -1) {
          const terminationDeadline = cleanupDeadline ?? Date.now() + NATIVE_WORKER_TERMINATION_BUDGET_MS
          const terminated = await terminateWorkerWithin(worker, terminationDeadline - Date.now())
          if (!terminated) throw cleanupFailure()

          if (shutdownCompletion) {
            const shutdownSettled = await waitWithin(shutdownCompletion, terminationDeadline - Date.now())
            if (!shutdownSettled.completed) throw cleanupFailure()
          }
          if (fiber) {
            // eslint-disable-next-line watchtower-effect/no-run-outside-composition-root
            const interruption = Effect.runPromise(Fiber.interrupt(fiber))
            const interrupted = await waitWithin(interruption, terminationDeadline - Date.now())
            const joined = await waitWithin(protocolCompletion, terminationDeadline - Date.now())
            if (!interrupted.completed || !joined.completed) throw cleanupFailure()
          }
        }
      } finally {
        worker.off('error', onError)
        worker.off('exit', onExit)
      }
    })()
    return closePromise
  }

  return { store: ready.store, close }
}

export const WorkspaceWorkerStoreLive = (options: WorkspaceWorkerStoreOptions) =>
  Layer.effect(
    WorkspaceStore,
    Effect.acquireRelease(
      Effect.tryPromise({
        try: () => openWorkspaceWorker(options),
        catch: cause => (cause instanceof WorkspaceStoreError ? cause : transportFailure()),
      }),
      worker =>
        Effect.tryPromise({
          try: () => worker.close(),
          catch: cause => (cause instanceof WorkspaceStoreError ? cause : cleanupFailure()),
        }).pipe(Effect.orDie),
    ).pipe(Effect.map(worker => WorkspaceStore.of(worker.store))),
  )
