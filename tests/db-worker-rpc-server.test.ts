import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import { describe, expect, it, vi } from 'vitest'

import type { DbWorkerContext, DbWorkerEmit } from '../src/platform/electron/workers/context.js'
import type { DbWorkerEvent } from '../src/platform/electron/workers/protocol.js'
import { dbWorkerRpcServerLayer } from '../src/platform/electron/workers/rpc-server.js'
import { WorkerEventSchema, WorkerRpcError, WorkerRpcGroup } from '../src/shared/rpc/worker.js'

function fakeContext(emit: DbWorkerEmit) {
  return {
    dispatchEffect: vi.fn((operation: string, args: unknown[]) =>
      Effect.sync(() => {
        if (operation === 'store:session') {
          expect(args).toEqual(['session-1'])
          return null
        }
        if (operation === 'models:addAlias') {
          emit({ event: 'config:changed' })
          return { ok: true }
        }
        if (operation === 'shutdown') return null
        return []
      }),
    ),
    close: vi.fn(async () => {}),
  } satisfies Pick<DbWorkerContext, 'dispatchEffect' | 'close'>
}

async function runServer<A, E, R>(
  layer: ReturnType<typeof dbWorkerRpcServerLayer>,
  effect: Effect.Effect<A, E, R>,
): Promise<A> {
  const provided = effect.pipe(
    Effect.scoped,
    Effect.provide(layer),
    Effect.catch(error => Effect.die(error)),
  )
  return Effect.runPromise(provided as Effect.Effect<A>)
}

describe('db-worker RPC server', () => {
  it('buffers initialization events and includes their watermark in unary acknowledgements', async () => {
    let context: ReturnType<typeof fakeContext> | undefined
    const layer = dbWorkerRpcServerLayer({
      createContext: async emit => {
        emit({ event: 'config:changed' })
        context = fakeContext(emit)
        return context
      },
      onFatal: vi.fn(),
    })

    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(WorkerRpcGroup)
      const events = yield* Effect.forkChild(Stream.runCollect(client['worker:events']().pipe(Stream.take(3))))
      const ready = yield* client['worker:ready']()
      const write = yield* client['models:addAlias']({ model: 'unknown-model', aliasOf: 'known-model' })
      const frames = yield* Fiber.join(events)
      return { ready, write, frames }
    })

    const result = await runServer(layer, program)
    expect(result.ready).toEqual({ value: true, eventSequence: 1 })
    expect(result.write).toEqual({ value: { ok: true }, eventSequence: 2 })
    expect(result.frames).toEqual([
      { sequence: 0, event: { event: 'worker:events-ready' } },
      { sequence: 1, event: { event: 'config:changed' } },
      { sequence: 2, event: { event: 'config:changed' } },
    ])
    expect(context?.dispatchEffect).toHaveBeenCalledWith('models:addAlias', ['unknown-model', 'known-model'])
  })

  it('accepts and sequences a synchronous 1024-event startup burst before the ready ACK', async () => {
    const burstSize = 1024
    const layer = dbWorkerRpcServerLayer({
      createContext: async emit => {
        for (let index = 0; index < burstSize; index++) {
          if (index % 2 === 0) {
            emit({
              event: 'scan:progress',
              manual: true,
              progress: { stage: 'parse', processed: index, total: burstSize },
            })
          } else {
            emit({
              event: 'oplog',
              level: 'info',
              logEvent: 'startup-burst',
              fields: { index },
            })
          }
        }
        return fakeContext(emit)
      },
      onFatal: vi.fn(),
    })

    let signalSubscribed!: () => void
    const subscribed = new Promise<void>(resolve => {
      signalSubscribed = resolve
    })
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(WorkerRpcGroup)
      const stream = yield* Effect.forkChild(
        Stream.runCollect(
          client['worker:events']().pipe(
            Stream.tap(frame => (frame.sequence === 0 ? Effect.sync(signalSubscribed) : Effect.void)),
            Stream.take(burstSize + 1),
          ),
        ),
      )
      yield* Effect.promise(() => subscribed)
      const ready = yield* client['worker:ready']()
      const frames = yield* Fiber.join(stream)
      return { ready, frames }
    })

    const result = await runServer(layer, program)
    expect(result.ready).toEqual({ value: true, eventSequence: burstSize })
    expect(result.frames).toHaveLength(burstSize + 1)
    expect(result.frames.map(frame => frame.sequence)).toEqual(
      Array.from({ length: burstSize + 1 }, (_, index) => index),
    )
    expect(result.frames.slice(1).filter(frame => frame.event.event === 'scan:progress')).toHaveLength(burstSize / 2)
    expect(result.frames.slice(1).filter(frame => frame.event.event === 'oplog')).toHaveLength(burstSize / 2)
  })

  it('preserves omitted source identity at the context boundary', async () => {
    let context: ReturnType<typeof fakeContext> | undefined
    const layer = dbWorkerRpcServerLayer({
      createContext: async emit => {
        context = fakeContext(emit)
        return context
      },
      onFatal: vi.fn(),
    })
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(WorkerRpcGroup)
      yield* client['worker:ready']()
      return yield* client['store:session']({ sessionId: 'session-1' })
    })

    const result = await runServer(layer, program)
    expect(result).toMatchObject({ value: null })
    expect(context?.dispatchEffect).toHaveBeenCalledWith('store:session', ['session-1'])
  })

  it('returns a fixed initialization error and reports fatal startup only once', async () => {
    const onFatal = vi.fn()
    const layer = dbWorkerRpcServerLayer({
      createContext: async () => {
        throw new Error('private C:\\users\\alice\\ledger.db')
      },
      onFatal,
    })
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(WorkerRpcGroup)
      const ready = yield* Effect.exit(client['worker:ready']())
      const again = yield* Effect.exit(client['worker:ready']())
      return { ready, again }
    })

    const { ready, again } = await runServer(layer, program)
    for (const result of [ready, again]) {
      expect(Exit.isFailure(result)).toBe(true)
      if (Exit.isFailure(result)) {
        const error = Cause.findError(result.cause)
        expect(error).toMatchObject({
          _tag: 'Success',
          success: new WorkerRpcError({
            code: 'initialization-failed',
            message: 'The database worker operation failed.',
          }),
        })
        expect(JSON.stringify(result)).not.toContain('alice')
      }
    }
    expect(onFatal).toHaveBeenCalledOnce()
  })

  it('joins pending context creation during finalization and closes a late context once', async () => {
    let signalFactoryStarted!: () => void
    const factoryStarted = new Promise<void>(resolve => {
      signalFactoryStarted = resolve
    })
    let releaseFactory!: (context: ReturnType<typeof fakeContext>) => void
    let context: ReturnType<typeof fakeContext> | undefined
    const layer = dbWorkerRpcServerLayer({
      createContext: async () => {
        signalFactoryStarted()
        const pending = new Promise<ReturnType<typeof fakeContext>>(resolve => {
          releaseFactory = resolve
        })
        context = await pending
        return context
      },
      onFatal: vi.fn(),
    })
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(WorkerRpcGroup)
      const ready = yield* Effect.forkChild(client['worker:ready']())
      yield* Effect.promise(() => factoryStarted)
      yield* Fiber.interrupt(ready)
    })

    const result = runServer(layer, program)
    let resultSettled = false
    void result.then(() => (resultSettled = true))
    await factoryStarted
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(resultSettled).toBe(false)
    releaseFactory(fakeContext(() => {}))
    await result
    expect(context?.close).toHaveBeenCalledOnce()
  })

  it('fails the generation instead of dropping a malformed broadcast', async () => {
    const onFatal = vi.fn()
    let context: ReturnType<typeof fakeContext> | undefined
    const layer = dbWorkerRpcServerLayer({
      createContext: async emit => {
        emit({ event: 'store:changed', metadata: { unsafe: true } } as unknown as DbWorkerEvent)
        context = fakeContext(emit)
        return context
      },
      onFatal,
    })
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(WorkerRpcGroup)
      return yield* Effect.exit(client['worker:ready']())
    })

    const result = await runServer(layer, program)
    expect(Exit.isFailure(result)).toBe(true)
    expect(onFatal).toHaveBeenCalledOnce()
    expect(context?.close).toHaveBeenCalledOnce()
    if (Exit.isFailure(result)) {
      const error = Cause.findError(result.cause)
      expect(error).toMatchObject({
        _tag: 'Success',
        success: new WorkerRpcError({ code: 'unavailable', message: 'The database worker operation failed.' }),
      })
    }
  })

  it('fails the generation when queued event bytes exceed the bound', async () => {
    const onFatal = vi.fn()
    const chunk = 'x'.repeat(900_000)
    const layer = dbWorkerRpcServerLayer({
      createContext: async emit => {
        for (let index = 0; index < 3; index++) {
          emit({ event: 'oplog', level: 'info', logEvent: 'bounded-test', fields: { detail: chunk } })
        }
        return fakeContext(emit)
      },
      onFatal,
    })
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(WorkerRpcGroup)
      return yield* Effect.exit(client['worker:ready']())
    })

    const result = await runServer(layer, program)
    expect(Exit.isFailure(result)).toBe(true)
    expect(onFatal).toHaveBeenCalledOnce()
    if (Exit.isFailure(result)) {
      const error = Cause.findError(result.cause)
      expect(error).toMatchObject({
        _tag: 'Success',
        success: new WorkerRpcError({ code: 'event-overflow', message: 'The database worker operation failed.' }),
      })
    }
  })

  it('fails the generation when queued event count exceeds the bound', async () => {
    const onFatal = vi.fn()
    const layer = dbWorkerRpcServerLayer({
      createContext: async emit => {
        for (let index = 0; index < 4097; index++) emit({ event: 'config:changed' })
        return fakeContext(emit)
      },
      onFatal,
    })
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(WorkerRpcGroup)
      return yield* Effect.exit(client['worker:ready']())
    })

    const result = await runServer(layer, program)
    expect(Exit.isFailure(result)).toBe(true)
    expect(onFatal).toHaveBeenCalledOnce()
    if (Exit.isFailure(result)) {
      const error = Cause.findError(result.cause)
      expect(error).toMatchObject({
        _tag: 'Success',
        success: new WorkerRpcError({ code: 'event-overflow', message: 'The database worker operation failed.' }),
      })
    }
  })

  it('rejects a malformed encoded request before it can dispatch', async () => {
    const dispatch = vi.fn(() => Effect.succeed(null))
    const request = WorkerRpcGroup.requests.get('overview:query')
    if (!request) throw new Error('overview:query contract is missing')
    const decoded = Schema.decodeUnknownResult(request.payloadSchema)({ scope: { period: 'yesterday' } })
    expect(decoded._tag).toBe('Failure')
    expect(dispatch).not.toHaveBeenCalled()
    const encoded = Schema.encodeUnknownResult(request.payloadSchema)({ scope: { period: 'today' } })
    expect(encoded._tag).toBe('Success')
  })

  it('rejects private scan failure text in both success results and events', () => {
    const scan = WorkerRpcGroup.requests.get('scan:start')
    if (!scan) throw new Error('scan:start contract is missing')
    const privateMessage = 'SQLITE_ERROR at C:\\Users\\alice\\ledger.db'

    expect(
      Schema.decodeUnknownResult(scan.successSchema)({
        value: { ok: false, aborted: false, error: privateMessage },
        eventSequence: 1,
      })._tag,
    ).toBe('Failure')
    expect(
      Schema.decodeUnknownResult(WorkerEventSchema)({
        event: 'scan:error',
        manual: true,
        message: privateMessage,
      })._tag,
    ).toBe('Failure')
  })
})
