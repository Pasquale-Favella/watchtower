import type { Worker } from 'node:worker_threads'

import * as NodeWorkerPlatform from '@effect/platform-node/NodeWorker'
import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import { RpcClient, RpcWorker } from 'effect/rpc'
import type { RpcClientError } from 'effect/rpc/RpcClientError'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import {
  WORKER_REQUEST_CAPACITY,
  type WorkerEvent,
  WorkerRpcError,
  WorkerRpcGroup,
  type WorkerRpcSuccess,
} from '../../../shared/rpc/worker.js'

type GeneratedWorkerRpcClient = RpcClient.FromGroup<typeof WorkerRpcGroup, RpcClientError>
type UnaryTag = Exclude<keyof GeneratedWorkerRpcClient, 'worker:events' | 'worker:ready'>

type UnwrapSuccess<T> = T extends WorkerRpcSuccess<infer A> ? A : never
type WorkerRpcClientFacade = {
  [Tag in UnaryTag]: GeneratedWorkerRpcClient[Tag] extends (
    ...args: infer Args
  ) => Effect.Effect<infer A, infer E, infer R>
    ? (...args: Args) => Effect.Effect<UnwrapSuccess<A>, E, R>
    : never
}

/** Typed operation methods whose results are released only after the event
 * stream has applied the watermark in the worker's success envelope. */
export type WorkerRpcClient = WorkerRpcClientFacade

export interface WorkerRpcTransport {
  readonly ready: Promise<void>
  readonly client: WorkerRpcClient
  /** Close the RPC scope. The owner retains native Worker termination policy. */
  close(): Promise<void>
}

export interface OpenWorkerRpcTransportOptions {
  readonly onEvent: (event: WorkerEvent) => void
  readonly onFailure: (error: WorkerRpcError) => void
}

interface DeferredPromise<A> {
  readonly promise: Promise<A>
  readonly resolve: (value: A) => void
  readonly reject: (cause: unknown) => void
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

function workerFailure(code: WorkerRpcError['code']): WorkerRpcError {
  return new WorkerRpcError({ code, message: 'The database worker operation failed.' })
}

function safeWorkerFailure(cause: unknown, initializing: boolean): WorkerRpcError {
  if (!Cause.isCause(cause)) return workerFailure(initializing ? 'initialization-failed' : 'unavailable')
  const error = Cause.findErrorOption(cause)
  if (error._tag === 'Some' && error.value instanceof WorkerRpcError) return error.value
  return workerFailure(initializing ? 'initialization-failed' : 'unavailable')
}

const protocolLayer = (worker: Worker) => {
  let supplied = false
  // The lifetime event stream holds one pool lease until the generation
  // closes. Reserve three slots beyond ordinary admitted calls for the stream,
  // cooperative abort, and shutdown control operations.
  return RpcClient.layerProtocolWorker({ size: 1, concurrency: WORKER_REQUEST_CAPACITY + 3 }).pipe(
    Layer.provide(
      Layer.merge(
        NodeWorkerPlatform.layer(() => {
          if (supplied) throw new Error('one protocol scope owns the supplied db-worker')
          supplied = true
          return worker
        }),
        RpcWorker.layerInitialMessage(Schema.Void, Effect.succeed(undefined)),
      ),
    ),
  )
}

/** Adapt one supervisor-owned native Worker to the typed db-worker contract.
 * This function never constructs, replaces, or terminates a native Worker. */
export async function openWorkerRpcTransport(
  worker: Worker,
  options: OpenWorkerRpcTransportOptions,
): Promise<WorkerRpcTransport> {
  const startup = deferred<{ client: WorkerRpcClient; fiber: Fiber.Fiber<void, unknown> }>()
  const ready = deferred<undefined>()
  const eventBarrier = deferred<undefined>()
  const stop = deferred<undefined>()
  const applied = new Set<{
    readonly sequence: number
    readonly resume: (effect: Effect.Effect<undefined, WorkerRpcError>) => void
  }>()

  let fiber: Fiber.Fiber<void, unknown> | null = null
  let client: WorkerRpcClient | null = null
  let appliedSequence = -1
  let generationFailure: WorkerRpcError | null = null
  let eventBarrierReady = false
  let closing = false
  let failureReported = false
  let closePromise: Promise<void> | null = null

  const settleApplied = (): void => {
    for (const waiter of applied) {
      if (waiter.sequence > appliedSequence) continue
      applied.delete(waiter)
      waiter.resume(Effect.succeed(undefined))
    }
  }

  const failWaiters = (error: WorkerRpcError): void => {
    for (const waiter of applied) waiter.resume(Effect.fail(error))
    applied.clear()
  }

  const failGeneration = (error: WorkerRpcError): void => {
    if (closing || generationFailure) return
    generationFailure = error
    if (!client) startup.reject(error)
    eventBarrier.reject(error)
    ready.reject(error)
    failWaiters(error)
    if (!failureReported) {
      failureReported = true
      try {
        options.onFailure(error)
      } catch {
        // Reporting cannot interfere with worker scope cleanup.
      }
    }
    stop.resolve(undefined)
    // The native Worker callback is the imperative edge that interrupts this scoped generation.
    // eslint-disable-next-line watchtower-effect/no-run-outside-composition-root
    if (fiber) void Effect.runPromise(Fiber.interrupt(fiber)).catch(() => {})
  }

  const waitApplied = (sequence: number): Effect.Effect<undefined, WorkerRpcError> =>
    Effect.callback<undefined, WorkerRpcError>((resume, signal) => {
      if (generationFailure) {
        resume(Effect.fail(generationFailure))
        return
      }
      if (sequence <= appliedSequence) {
        resume(Effect.succeed(undefined))
        return
      }
      const waiter = { sequence, resume }
      applied.add(waiter)
      const remove = (): void => {
        applied.delete(waiter)
        signal.removeEventListener('abort', remove)
      }
      signal.addEventListener('abort', remove, { once: true })
      return Effect.sync(remove)
    })

  const awaitReady = Effect.tryPromise({
    try: () => ready.promise,
    catch: cause => (cause instanceof WorkerRpcError ? cause : workerFailure('unavailable')),
  })

  const onError = (): void => failGeneration(workerFailure(readySettled ? 'unavailable' : 'initialization-failed'))
  const onExit = (): void => {
    if (!closing) failGeneration(workerFailure(readySettled ? 'unavailable' : 'initialization-failed'))
  }
  let readySettled = false
  worker.on('error', onError)
  worker.on('exit', onExit)

  const program = Effect.scoped(
    Effect.gen(function* () {
      const protocol = yield* Layer.build(protocolLayer(worker))
      const rawClient = yield* RpcClient.make(WorkerRpcGroup).pipe(
        Effect.provideService(RpcClient.Protocol, Context.get(protocol, RpcClient.Protocol)),
      )

      const wrapped = new Proxy({} as WorkerRpcClient, {
        get(_target, key: string) {
          const call = rawClient[key as keyof GeneratedWorkerRpcClient]
          if (typeof call !== 'function' || key === 'worker:events' || key === 'worker:ready') return undefined
          return (...args: ReadonlyArray<unknown>) =>
            Effect.flatMap(awaitReady, () => {
              const operation = call as (
                ...input: ReadonlyArray<unknown>
              ) => Effect.Effect<WorkerRpcSuccess<unknown>, RpcClientError | WorkerRpcError>
              const request = Effect.suspend(() => operation(...args)).pipe(
                Effect.catch(error =>
                  error instanceof WorkerRpcError && error.eventSequence !== undefined
                    ? Effect.flatMap(waitApplied(error.eventSequence), () => Effect.fail(error))
                    : Effect.fail(error),
                ),
              )
              return Effect.flatMap(request, result => Effect.as(waitApplied(result.eventSequence), result.value))
            })
        },
      })
      client = wrapped
      startup.resolve({ client: wrapped, fiber: Fiber.getCurrent() as Fiber.Fiber<void, unknown> })

      const eventStream = rawClient['worker:events'](undefined)
      const consumeEvents = Effect.gen(function* () {
        yield* eventStream.pipe(
          Stream.runForEach(event =>
            Effect.suspend(() => {
              if (!eventBarrierReady) {
                if (event.sequence !== 0 || event.event.event !== 'worker:events-ready')
                  return Effect.fail(workerFailure('unavailable'))
                eventBarrierReady = true
                appliedSequence = 0
                settleApplied()
                eventBarrier.resolve(undefined)
                return Effect.succeed(undefined)
              }
              if (event.sequence !== appliedSequence + 1 || event.event.event === 'worker:events-ready')
                return Effect.fail(workerFailure('unavailable'))
              try {
                options.onEvent(event.event)
              } catch {
                return Effect.fail(workerFailure('unavailable'))
              }
              appliedSequence = event.sequence
              settleApplied()
              return Effect.succeed(undefined)
            }),
          ),
        )
      }).pipe(
        Effect.catchCause(cause => Effect.sync(() => failGeneration(safeWorkerFailure(cause, !readySettled)))),
        Effect.ensuring(
          Effect.sync(() => {
            if (!closing && !generationFailure)
              failGeneration(workerFailure(readySettled ? 'unavailable' : 'initialization-failed'))
          }),
        ),
      )
      yield* Effect.forkChild(consumeEvents, { startImmediately: true })

      yield* Effect.tryPromise({ try: () => eventBarrier.promise, catch: cause => cause })
      const readyAck = yield* rawClient['worker:ready'](undefined)
      yield* waitApplied(readyAck.eventSequence)
      readySettled = true
      ready.resolve(undefined)
      yield* Effect.promise(() => stop.promise)
    }).pipe(
      // Preserve a typed readiness failure before scope teardown interrupts
      // the event consumer and could replace it with a generic close failure.
      Effect.catchCause(cause =>
        Effect.sync(() => failGeneration(safeWorkerFailure(cause, !readySettled))).pipe(
          Effect.andThen(Effect.failCause(cause)),
        ),
      ),
    ),
  )

  // Opening the native transport is its scoped Effect composition root.
  // eslint-disable-next-line watchtower-effect/no-run-outside-composition-root
  fiber = Effect.runFork(program)
  fiber.addObserver(exit => {
    worker.off('error', onError)
    worker.off('exit', onExit)
    if (exit._tag === 'Failure') {
      const error = safeWorkerFailure(exit.cause, !readySettled)
      failGeneration(error)
      startup.reject(error)
    } else if (!closing && !generationFailure) {
      const error = workerFailure(readySettled ? 'unavailable' : 'initialization-failed')
      failGeneration(error)
      startup.reject(error)
    }
  })

  let exposed: { client: WorkerRpcClient; fiber: Fiber.Fiber<void, unknown> }
  try {
    exposed = await startup.promise
  } catch (cause) {
    if (fiber) {
      // Failed opens cannot return a handle, so drain this partial scope before surfacing the error.
      // eslint-disable-next-line watchtower-effect/no-run-outside-composition-root
      await Effect.runPromise(Fiber.interrupt(fiber))
      // eslint-disable-next-line watchtower-effect/no-run-outside-composition-root
      await Effect.runPromise(Fiber.await(fiber))
    }
    worker.off('error', onError)
    worker.off('exit', onExit)
    throw cause
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      closing = true
      stop.resolve(undefined)
      // `close()` is the Promise boundary exposed to the supervisor.
      // eslint-disable-next-line watchtower-effect/no-run-outside-composition-root
      await Effect.runPromise(Fiber.interrupt(exposed.fiber))
      // Join scoped cleanup before allowing the supervisor to release this generation.
      // eslint-disable-next-line watchtower-effect/no-run-outside-composition-root
      await Effect.runPromise(Fiber.await(exposed.fiber))
      worker.off('error', onError)
      worker.off('exit', onExit)
    })()
    return closePromise
  }

  return { ready: ready.promise, client: exposed.client, close }
}
