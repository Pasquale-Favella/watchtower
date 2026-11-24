import * as BrowserWorker from '@effect/platform-browser/BrowserWorker'
import * as BrowserWorkerRunner from '@effect/platform-browser/BrowserWorkerRunner'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import { Rpc, RpcGroup } from 'effect/rpc'
import * as RpcClient from 'effect/rpc/RpcClient'
import * as RpcServer from 'effect/rpc/RpcServer'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'
import * as Semaphore from 'effect/Semaphore'
import * as Transferable from 'effect/workers/Transferable'
import type * as WorkerRunner from 'effect/workers/WorkerRunner'

export type Method<Input, Output> = { readonly input: Input; readonly output: Output }
export type Methods = Readonly<Record<string, Method<unknown, unknown>>>
export type MethodContract<Input, Output> = {
  readonly input: Schema.Schema<Input>
  readonly output: Schema.Schema<Output>
}
export type MethodContracts<M extends Methods> = {
  readonly [K in keyof M]: MethodContract<M[K]['input'], M[K]['output']>
}

export class WorkerRpcError extends Schema.TaggedError<WorkerRpcError>()('WorkerRpcError', {
  code: Schema.Literals(['closed', 'aborted', 'timeout', 'superseded', 'busy', 'failed']),
  message: Schema.String,
}) {}

const transfers = Transferable.schema(Schema.Array(Schema.Any), items => items as readonly globalThis.Transferable[])
// Worker payloads use structured clone, which includes buffers outside JSON's value set.
const clonedValue = Transferable.schema(Schema.Any, () => [])
const resultSchema = Schema.Struct({ value: clonedValue, transfers })
export const PreviewWorkerRpc = RpcGroup.make(
  Rpc.make('preview:invoke', {
    payload: { method: Schema.String, input: clonedValue, transfers },
    success: resultSchema,
    error: WorkerRpcError,
  }),
)

export interface CallOptions {
  readonly key?: string | undefined
  readonly transfer?: readonly globalThis.Transferable[] | undefined
  readonly signal?: AbortSignal | undefined
  readonly timeoutMs?: number | undefined
}

export interface WorkerClient<M extends Methods> {
  readonly call: <K extends keyof M & string>(
    method: K,
    input: M[K]['input'],
    options?: CallOptions,
  ) => Effect.Effect<M[K]['output'], WorkerRpcError>
  readonly close: Effect.Effect<void>
}

export class Transfer<Value> {
  constructor(
    readonly value: Value,
    readonly transfer: readonly globalThis.Transferable[],
  ) {}
}

interface ScheduledCall {
  readonly canceled: Deferred.Deferred<never, WorkerRpcError>
  readonly release: () => void
  started: boolean
}

function failure(code: WorkerRpcError['code'], message: string): WorkerRpcError {
  return new WorkerRpcError({ code, message })
}

function validate<Value>(
  schema: Schema.Schema<Value>,
  value: unknown,
  message: string,
): Effect.Effect<Value, WorkerRpcError> {
  return Schema.is(schema)(value) ? Effect.succeed(value) : Effect.fail(failure('failed', message))
}

function aborted(signal: AbortSignal): Effect.Effect<never, WorkerRpcError> {
  return Effect.callback(resume => {
    function cancel(): void {
      resume(Effect.fail(failure('aborted', 'The preview request was canceled.')))
    }
    if (signal.aborted) {
      cancel()
      return
    }
    signal.addEventListener('abort', cancel, { once: true })
    return Effect.sync(() => signal.removeEventListener('abort', cancel))
  })
}

/** The caller's Scope owns the official worker transport, pending requests and native worker. */
export const makeWorkerClient = <M extends Methods>(
  worker: Worker,
  contracts: MethodContracts<M>,
): Effect.Effect<WorkerClient<M>, WorkerRpcError, Scope.Scope> =>
  Effect.gen(function* () {
    const lifetime = yield* Scope.fork(yield* Effect.scope)
    const stopped = yield* Deferred.make<never, WorkerRpcError>()
    const gate = yield* Semaphore.make(1)
    const keyed = new Map<string, ScheduledCall>()
    let count = 0
    let closed = false

    const stop = (cause: WorkerRpcError) =>
      Effect.gen(function* () {
        if (closed) return
        closed = true
        yield* Deferred.fail(stopped, cause)
        yield* Effect.sync(() => worker.terminate())
        yield* Scope.close(lifetime, Exit.void)
      })
    yield* Effect.addFinalizer(() => stop(failure('closed', 'The preview worker was closed.')))

    const protocol = RpcClient.layerProtocolWorker({ size: 1, concurrency: 1 }).pipe(
      Layer.provide(BrowserWorker.layer(() => worker)),
    )
    const services = yield* Layer.buildWithScope(protocol, lifetime).pipe(
      Effect.mapError(() => failure('failed', 'The preview worker could not start.')),
    )
    const client = yield* RpcClient.make(PreviewWorkerRpc).pipe(
      Effect.provideContext(services),
      Effect.provideService(Scope.Scope, lifetime),
      Effect.mapError(() => failure('failed', 'The preview worker could not start.')),
    )

    yield* Deferred.await(stopped).pipe(
      Effect.exit,
      Effect.andThen(Scope.close(lifetime, Exit.void)),
      Effect.forkScoped,
    )
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        function failWorker(): void {
          closed = true
          Deferred.doneUnsafe(stopped, Effect.fail(failure('failed', 'The preview worker stopped unexpectedly.')))
          worker.terminate()
        }
        worker.addEventListener('error', failWorker)
        worker.addEventListener('messageerror', failWorker)
        return failWorker
      }),
      listener =>
        Effect.sync(() => {
          worker.removeEventListener('error', listener)
          worker.removeEventListener('messageerror', listener)
        }),
    )

    function call<K extends keyof M & string>(
      method: K,
      input: M[K]['input'],
      options: CallOptions = {},
    ): Effect.Effect<M[K]['output'], WorkerRpcError> {
      return Effect.suspend(() => {
        if (closed) return Effect.fail(failure('closed', 'The preview worker was closed.'))
        if (options.signal?.aborted) return Effect.fail(failure('aborted', 'The preview request was canceled.'))
        if (!Object.hasOwn(contracts, method))
          return Effect.fail(failure('failed', 'The preview operation is unavailable.'))
        const previous = options.key ? keyed.get(options.key) : undefined
        if (previous && !previous.started) {
          Deferred.doneUnsafe(
            previous.canceled,
            Effect.fail(failure('superseded', 'A newer preview request replaced this one.')),
          )
          previous.release()
        }
        if (count >= 32)
          return Effect.fail(failure('busy', 'The preview queue is full. Retry when the current request finishes.'))
        let counted = true
        const scheduled: ScheduledCall = {
          canceled: Deferred.makeUnsafe(),
          started: false,
          release() {
            if (!counted) return
            counted = false
            count--
            if (options.key && keyed.get(options.key) === scheduled) keyed.delete(options.key)
          },
        }
        if (options.key) keyed.set(options.key, scheduled)
        count++
        const contract = contracts[method]
        const invoke = gate.withPermit(
          validate(contract.input, input, `Invalid input for preview operation "${method}".`).pipe(
            Effect.flatMap(validatedInput =>
              Effect.suspend(() => {
                scheduled.started = true
                return client['preview:invoke']({
                  method,
                  input: validatedInput,
                  transfers: [...(options.transfer ?? [])],
                }).pipe(
                  Effect.flatMap(response =>
                    validate(contract.output, response.value, `Invalid result for preview operation "${method}".`),
                  ),
                  Effect.mapError(cause =>
                    Schema.is(WorkerRpcError)(cause)
                      ? cause
                      : failure('failed', 'The preview worker returned an invalid result.'),
                  ),
                )
              }),
            ),
          ),
        )
        let result = Effect.raceFirst(invoke, Deferred.await(scheduled.canceled)).pipe(
          Effect.raceFirst(Deferred.await(stopped)),
        )
        if (options.signal) result = Effect.raceFirst(result, aborted(options.signal))
        return result.pipe(
          Effect.timeoutOrElse({
            duration: options.timeoutMs ?? 30_000,
            orElse: () => {
              const cause = failure('timeout', 'The preview worker exceeded its time limit. Reopen the file to retry.')
              return stop(cause).pipe(Effect.andThen(Effect.fail(cause)))
            },
          }),
          Effect.ensuring(Effect.sync(scheduled.release)),
        )
      })
    }
    return { call, close: stop(failure('closed', 'The preview worker was closed.')) }
  })

type Handlers<M extends Methods> = {
  readonly [K in keyof M]: (
    input: M[K]['input'],
    signal: AbortSignal,
  ) => M[K]['output'] | Transfer<M[K]['output']> | Promise<M[K]['output'] | Transfer<M[K]['output']>>
}

/** Run only at a worker entry point. RPC interruption supplies each native operation's AbortSignal. */
export function serveWorker<M extends Methods>(
  contracts: MethodContracts<M>,
  handlers: Handlers<M>,
  runner: Layer.Layer<WorkerRunner.WorkerRunnerPlatform> = BrowserWorkerRunner.layer,
) {
  return RpcServer.make(PreviewWorkerRpc, { concurrency: 1 }).pipe(
    Effect.provide(
      PreviewWorkerRpc.toLayer({
        'preview:invoke': request =>
          Effect.suspend(() => {
            if (!Object.hasOwn(handlers, request.method) || !Object.hasOwn(contracts, request.method))
              return Effect.fail(failure('failed', 'The preview operation is unavailable.'))
            const method = request.method as keyof M & string
            const handler = handlers[method]
            const contract = contracts[method]
            return validate(
              contract.input,
              request.input,
              `Invalid input for preview operation "${request.method}".`,
            ).pipe(
              Effect.flatMap(input =>
                Effect.tryPromise({
                  try: signal => Promise.resolve(handler(input as never, signal)),
                  catch: cause =>
                    failure('failed', cause instanceof Error ? cause.message : 'The document could not be previewed.'),
                }),
              ),
              Effect.flatMap(result => {
                const transfer = result instanceof Transfer ? result.transfer : []
                const value = result instanceof Transfer ? result.value : result
                return validate(
                  contract.output,
                  value,
                  `Invalid result for preview operation "${request.method}".`,
                ).pipe(Effect.map(validated => ({ value: validated, transfers: [...transfer] })))
              }),
            )
          }),
      }),
    ),
    Effect.provide(RpcServer.layerProtocolWorkerRunner),
    Effect.provide(runner),
  )
}
