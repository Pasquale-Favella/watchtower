import * as Cause from 'effect/Cause'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import type * as Rpc from 'effect/rpc/Rpc'
import type * as RpcGroup from 'effect/rpc/RpcGroup'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'

import {
  SequencedWorkerEventSchema,
  WorkerEventSchema,
  WorkerRpcError,
  WorkerRpcGroup,
  type WorkerRpcSuccess,
} from '@/shared/rpc/worker.js'
import type { DbWorkerContext, DbWorkerEmit } from '@/platform/electron/workers/context.js'
import type { DbWorkerEvent } from '@/platform/electron/workers/protocol.js'
import { workerRpcError } from '@/platform/electron/workers/rpc-errors.js'

const EVENT_CAPACITY = 4096
const EVENT_BYTE_CAPACITY = 2 * 1024 * 1024
const SINGLE_EVENT_BYTE_CAPACITY = 1024 * 1024

type WorkerContext = Pick<DbWorkerContext, 'dispatchEffect' | 'close'>
type FatalHandler = (error: WorkerRpcError) => void

export interface DbWorkerRpcServerOptions {
  /** Construct the existing worker context/runtime and wire its broadcasts here. */
  readonly createContext: (emit: DbWorkerEmit) => Promise<WorkerContext>
  /** Notify the existing supervisor that this worker generation is no longer usable. */
  readonly onFatal: FatalHandler
}

type WorkerRpcDefinition = RpcGroup.Rpcs<typeof WorkerRpcGroup>
type WorkerUnaryTag = Exclude<WorkerRpcDefinition['_tag'], 'worker:events'>
type WorkerUnarySuccess<Tag extends WorkerUnaryTag> = Rpc.Success<Extract<WorkerRpcDefinition, { readonly _tag: Tag }>>

interface WorkerRpcServerStateService {
  readonly ready: () => Effect.Effect<WorkerRpcSuccess<true>, WorkerRpcError>
  readonly dispatch: <Tag extends WorkerUnaryTag>(
    tag: Tag,
    operation: string,
    args: unknown[],
    failureCode: 'query-failed' | 'command-failed',
  ) => Effect.Effect<WorkerUnarySuccess<Tag>, WorkerRpcError>
  readonly events: () => Stream.Stream<SequencedWorkerEvent, WorkerRpcError>
  readonly close: () => Effect.Effect<void>
}

type SequencedWorkerEvent = Schema.Schema.Type<typeof SequencedWorkerEventSchema>

class WorkerRpcServerState extends Context.Service<WorkerRpcServerState, WorkerRpcServerStateService>()(
  'watchtower/main/DbWorkerRpcServerState',
) {}

const workerError = (code: WorkerRpcError['code']): WorkerRpcError =>
  new WorkerRpcError({ code, message: 'The database worker operation failed.' })

const byteLength = (value: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

class WorkerRpcServerStateImpl implements WorkerRpcServerStateService {
  private readonly queue: Queue.Queue<SequencedWorkerEvent, WorkerRpcError>
  private readonly options: DbWorkerRpcServerOptions
  private contextPromise: Promise<WorkerContext> | undefined
  private context: WorkerContext | undefined
  private contextClosePromise: Promise<void> | undefined
  private closePromise: Promise<void> | undefined
  private closing = false
  private failure: WorkerRpcError | undefined
  private eventSequence = 0
  private queuedEventCount = 0
  private queuedEventBytes = 0
  private activeConsumer = false

  constructor(queue: Queue.Queue<SequencedWorkerEvent, WorkerRpcError>, options: DbWorkerRpcServerOptions) {
    this.queue = queue
    this.options = options
  }

  readonly ready = (): Effect.Effect<WorkerRpcSuccess<true>, WorkerRpcError> =>
    Effect.tryPromise({
      try: async () => {
        await this.getContext()
        return { value: true as const, eventSequence: this.eventSequence }
      },
      catch: error => (error instanceof WorkerRpcError ? error : workerRpcError(error, 'initialization-failed')),
    })

  readonly dispatch = <Tag extends WorkerUnaryTag>(
    tag: Tag,
    operation: string,
    args: unknown[],
    failureCode: 'query-failed' | 'command-failed',
  ): Effect.Effect<WorkerUnarySuccess<Tag>, WorkerRpcError> =>
    Effect.tryPromise({
      try: () => this.getContext(),
      catch: error => (error instanceof WorkerRpcError ? error : this.operationError(error, failureCode)),
    }).pipe(
      Effect.flatMap(context =>
        context.dispatchEffect(operation, args).pipe(
          Effect.map(value => {
            if (operation === 'shutdown') this.contextClosePromise ??= Promise.resolve()
            return { value, eventSequence: this.eventSequence }
          }),
          Effect.catchCause(cause => Effect.fail(this.operationError(cause, failureCode))),
        ),
      ),
      Effect.flatMap(result => this.decodeSuccess(tag, result, failureCode)),
    )

  readonly events = (): Stream.Stream<SequencedWorkerEvent, WorkerRpcError> =>
    Stream.unwrap(
      Effect.suspend(() => {
        if (this.activeConsumer) return Effect.fail(workerError('conflict'))
        this.activeConsumer = true
        const readyEvent = Schema.decodeUnknownResult(SequencedWorkerEventSchema)({
          sequence: 0,
          event: { event: 'worker:events-ready' },
        })
        if (readyEvent._tag === 'Failure') {
          this.activeConsumer = false
          return Effect.fail(workerError('unavailable'))
        }
        const eventStream = Stream.fromQueue(this.queue).pipe(
          Stream.mapEffect(frame =>
            Effect.sync(() => {
              this.queuedEventCount = Math.max(0, this.queuedEventCount - 1)
              this.queuedEventBytes = Math.max(0, this.queuedEventBytes - byteLength(frame))
              return frame
            }),
          ),
        )
        return Effect.succeed(
          Stream.concat(Stream.make(readyEvent.success), eventStream).pipe(
            Stream.ensuring(Effect.sync(() => (this.activeConsumer = false))),
          ),
        )
      }),
    )

  readonly close = (): Effect.Effect<void> =>
    Effect.tryPromise({
      try: () => {
        this.closing = true
        this.closePromise ??= (async () => {
          let context = this.context
          if (!context && this.contextPromise) {
            try {
              context = await this.contextPromise
            } catch {
              return
            }
          }
          if (context) await this.closeContext(context)
        })()
        return this.closePromise
      },
      catch: () => undefined,
    }).pipe(Effect.catchCause(() => Effect.void))

  acceptEvent = (raw: DbWorkerEvent): void => {
    if (this.failure) return
    this.eventSequence += 1
    const decoded = (() => {
      try {
        return Schema.decodeUnknownResult(WorkerEventSchema)(raw)
      } catch {
        return null
      }
    })()
    if (decoded === null) {
      this.failGeneration(workerError('unavailable'))
      return
    }
    if (decoded._tag === 'Failure' || decoded.success.event === 'worker:events-ready') {
      this.failGeneration(workerError('unavailable'))
      return
    }
    const sequenced = { sequence: this.eventSequence, event: decoded.success }
    const bytes = byteLength(sequenced)
    if (
      bytes > SINGLE_EVENT_BYTE_CAPACITY ||
      this.queuedEventCount >= EVENT_CAPACITY ||
      this.queuedEventBytes + bytes > EVENT_BYTE_CAPACITY ||
      !Queue.offerUnsafe(this.queue, sequenced)
    ) {
      this.failGeneration(workerError('event-overflow'))
      return
    }
    this.queuedEventCount += 1
    this.queuedEventBytes += bytes
  }

  private getContext(): Promise<WorkerContext> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closing) return Promise.reject(workerError('shutting-down'))
    this.contextPromise ??= Promise.resolve()
      .then(() => this.options.createContext(this.acceptEvent))
      .then(async context => {
        this.context = context
        if (this.failure || this.closing) {
          await this.closeContext(context)
          throw this.failure ?? workerError('shutting-down')
        }
        return context
      })
      .catch(error => {
        const failure = error instanceof WorkerRpcError ? error : workerRpcError(error, 'initialization-failed')
        this.failGeneration(failure)
        throw failure
      })
    return this.contextPromise
  }

  private closeContext(context: WorkerContext): Promise<void> {
    this.contextClosePromise ??= Promise.resolve()
      .then(() => context.close())
      .catch(() => undefined)
    return this.contextClosePromise
  }

  private decodeSuccess<Tag extends WorkerUnaryTag>(
    tag: Tag,
    result: { readonly value: unknown; readonly eventSequence: number },
    failureCode: 'query-failed' | 'command-failed',
  ): Effect.Effect<WorkerUnarySuccess<Tag>, WorkerRpcError> {
    const rpc = WorkerRpcGroup.requests.get(tag)
    if (!rpc) return Effect.fail(workerError('unavailable'))
    const decoded = Schema.decodeUnknownResult(rpc.successSchema)(result)
    return decoded._tag === 'Failure'
      ? Effect.fail(this.operationError(workerError(failureCode), failureCode))
      : Effect.succeed(decoded.success as WorkerUnarySuccess<Tag>)
  }

  private operationError(error: unknown, fallbackCode: 'query-failed' | 'command-failed'): WorkerRpcError {
    const safe = workerRpcError(error, fallbackCode)
    return new WorkerRpcError({
      code: safe.code,
      message: safe.message,
      eventSequence: this.eventSequence,
    })
  }

  private failGeneration(error: WorkerRpcError): void {
    if (this.failure) return
    this.failure = error
    Queue.failCauseUnsafe(this.queue, Cause.fail(error))
    try {
      this.options.onFatal(error)
    } catch {
      // The failed generation is already visible through the RPC stream.
    }
  }
}

/** Build one typed RPC handler layer over the worker's existing context. */
export function dbWorkerRpcServerLayer(options: DbWorkerRpcServerOptions) {
  const stateLayer = Layer.effect(
    WorkerRpcServerState,
    Effect.gen(function* () {
      const queue = yield* Queue.bounded<SequencedWorkerEvent, WorkerRpcError>(EVENT_CAPACITY)
      const state = new WorkerRpcServerStateImpl(queue, options)
      yield* Effect.addFinalizer(state.close)
      return WorkerRpcServerState.of(state)
    }),
  )

  const query = <Tag extends WorkerUnaryTag>(tag: Tag, operation: string, args: unknown[] = []) =>
    Effect.flatMap(WorkerRpcServerState, state => state.dispatch(tag, operation, args, 'query-failed'))
  const command = <Tag extends WorkerUnaryTag>(tag: Tag, operation: string, args: unknown[] = []) =>
    Effect.flatMap(WorkerRpcServerState, state => state.dispatch(tag, operation, args, 'command-failed'))

  const handlers = WorkerRpcGroup.toLayer({
    'worker:ready': () => Effect.flatMap(WorkerRpcServerState, state => state.ready()),
    'worker:events': () => Stream.unwrap(Effect.map(WorkerRpcServerState, state => state.events())),
    'store:views': () => query('store:views', 'store:views'),
    'store:projects': () => query('store:projects', 'store:projects'),
    'store:sessions': ({ filter }) => query('store:sessions', 'store:sessions', filter === undefined ? [] : [filter]),
    'store:session': ({ sessionId, sourceId }) =>
      query('store:session', 'store:session', sourceId === undefined ? [sessionId] : [sessionId, sourceId]),
    'store:analytics': () => query('store:analytics', 'store:analytics'),
    'overview:query': ({ scope }) => query('overview:query', 'overview:query', [scope]),
    'sessions:view': ({ scope }) => query('sessions:view', 'sessions:view', [scope]),
    'pullRequests:view': ({ scope }) => query('pullRequests:view', 'pullRequests:view', [scope]),
    'spend:view': ({ scope }) => query('spend:view', 'spend:view', [scope]),
    'models:view': ({ scope }) => query('models:view', 'models:view', [scope]),
    'compare:view': ({ scope, pair }) =>
      query('compare:view', 'compare:view', pair === undefined ? [scope] : [scope, pair]),
    'optimize:view': ({ scope }) => query('optimize:view', 'optimize:view', [scope]),
    'optimize:yield': ({ scope }) => query('optimize:yield', 'optimize:yield', [scope]),
    'skills:view': ({ scope, thresholds }) =>
      query('skills:view', 'skills:view', thresholds === undefined ? [scope] : [scope, thresholds]),
    'store:search': ({ query: search }) => query('store:search', 'store:search', [search]),
    'export:csv': ({ outputPath }) => command('export:csv', 'export:csv', [outputPath]),
    'export:json': ({ outputPath }) => command('export:json', 'export:json', [outputPath]),
    'skills:dismiss': request => command('skills:dismiss', 'skills:dismiss', [request]),
    'models:addAlias': ({ model, aliasOf }) => command('models:addAlias', 'models:addAlias', [model, aliasOf]),
    'models:getAliases': () => query('models:getAliases', 'models:getAliases'),
    'models:removeAlias': ({ model }) => command('models:removeAlias', 'models:removeAlias', [model]),
    'models:getPriceOverrides': () => query('models:getPriceOverrides', 'models:getPriceOverrides'),
    'models:removePriceOverride': ({ model }) =>
      command('models:removePriceOverride', 'models:removePriceOverride', [model]),
    'models:setPrice': ({ model, inputPricePerMillion, outputPricePerMillion }) =>
      command('models:setPrice', 'models:setPrice', [model, inputPricePerMillion, outputPricePerMillion]),
    'ledger-mcp:startup:get': () => query('ledger-mcp:startup:get', 'ledger-mcp:startup:get'),
    'ledger-mcp:startup:set': ({ mode }) => command('ledger-mcp:startup:set', 'ledger-mcp:startup:set', [mode]),
    'scan:start': ({ provider }) => command('scan:start', 'scan:start', provider === undefined ? [] : [{ provider }]),
    'scan:active': () => query('scan:active', 'scan:active'),
    'scan:abort': () => command('scan:abort', 'scan:abort'),
    'worker:shutdown': () => command('worker:shutdown', 'shutdown'),
    'cadence:get': () => query('cadence:get', 'cadence:get'),
    'cadence:set': ({ value }) => command('cadence:set', 'cadence:set', [value]),
    'store:status': () => query('store:status', 'store:status'),
    'settings:info': () => query('settings:info', 'settings:info'),
    'settings:clear': () => command('settings:clear', 'settings:clear'),
    'pricing:refresh': () => command('pricing:refresh', 'pricing:refresh'),
    'currency:get': () => query('currency:get', 'currency:get'),
    'currency:set': ({ code }) => command('currency:set', 'currency:set', [code]),
    'currency:list': () => query('currency:list', 'currency:list'),
  })

  return handlers.pipe(Layer.provide(stateLayer))
}
