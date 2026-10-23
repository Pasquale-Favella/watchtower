import { Cause, Deferred, Effect, Exit, Fiber, Layer, Result, Schema, Stream } from 'effect'
import { Rpc, RpcClient, RpcGroup, RpcServer } from 'effect/rpc'
import { describe, expect, it } from 'vitest'

import {
  clientProtocolLayer,
  type RpcMessagePort,
  RpcPortError,
  serverProtocolLayer,
} from '../src/shared/rpc/port-protocol.js'

class QueryFailure extends Schema.TaggedError<QueryFailure>()('QueryFailure', {
  code: Schema.Literal('expected'),
}) {}

const Query = Rpc.make('Query', { payload: { value: Schema.String }, success: Schema.String })
const Fail = Rpc.make('Fail', { error: QueryFailure })
const Numbers = Rpc.make('Numbers', {
  payload: { count: Schema.Int },
  success: Schema.Int,
  stream: true,
})
const Wait = Rpc.make('Wait', { success: Schema.String })
const Defect = Rpc.make('Defect', { success: Schema.String })
const TestRpcs = Rpc.make('Noop', { success: Schema.Void })
const group = RpcGroup.make(Query, Fail, Numbers, Wait, Defect, TestRpcs)

interface PortState {
  closed: boolean
  readonly receive: Set<(frame: unknown) => void>
  readonly closeListeners: Set<() => void>
  removals: number
  closeCalls: number
  readonly sent: string[]
}

const makePortPair = (): readonly [RpcMessagePort, RpcMessagePort, readonly [PortState, PortState]] => {
  const createState = (): PortState => ({
    closed: false,
    receive: new Set(),
    closeListeners: new Set(),
    removals: 0,
    closeCalls: 0,
    sent: [],
  })
  const left = createState()
  const right = createState()
  const notifyClosed = (state: PortState) => {
    if (state.closed) return
    state.closed = true
    for (const listener of [...state.closeListeners]) listener()
  }
  const makePort = (local: PortState, remote: PortState): RpcMessagePort => ({
    send: frame =>
      Effect.suspend(() => {
        if (local.closed || remote.closed) return Effect.fail(new RpcPortError({ code: 'closed' }))
        local.sent.push(frame)
        for (const listener of [...remote.receive]) listener(structuredClone(frame))
        return Effect.void
      }),
    subscribe: receive =>
      Effect.sync(() => {
        local.receive.add(receive)
        let active = true
        return () => {
          if (!active) return
          active = false
          local.removals++
          local.receive.delete(receive)
        }
      }),
    subscribeClose: onClose =>
      Effect.sync(() => {
        if (local.closed) onClose()
        else local.closeListeners.add(onClose)
        let active = true
        return () => {
          if (!active) return
          active = false
          local.removals++
          local.closeListeners.delete(onClose)
        }
      }),
    close: () =>
      Effect.sync(() => {
        local.closeCalls++
        notifyClosed(local)
        notifyClosed(remote)
      }),
  })
  return [makePort(left, right), makePort(right, left), [left, right]]
}

const makeHarness = (clientPort: RpcMessagePort, serverPort: RpcMessagePort) => {
  const started = Deferred.makeUnsafe<undefined>()
  let waitInterrupted = false
  let noopCalls = 0
  const handlers = group.toLayer(
    group.of({
      Query: ({ value }) => Effect.succeed(`answer:${value}`),
      Fail: () => Effect.fail(new QueryFailure({ code: 'expected' })),
      Numbers: ({ count }) =>
        Stream.fromIterable(Array.from({ length: count }, (_, index) => index + 1)).pipe(Stream.rechunk(1)),
      Wait: () =>
        Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(
          Effect.onInterrupt(() => Effect.sync(() => (waitInterrupted = true))),
        ),
      Defect: () => Effect.die(new Error('secret C:\\private\\ledger.db stack trace')),
      Noop: () =>
        Effect.sync(() => {
          noopCalls += 1
        }),
    }),
  )
  const serverLayer = Layer.provide(RpcServer.layer(group), Layer.merge(serverProtocolLayer(serverPort), handlers))
  const clientLayer = clientProtocolLayer(clientPort)
  return { started, waitInterrupted: () => waitInterrupted, noopCalls: () => noopCalls, serverLayer, clientLayer }
}

describe('Effect RPC port protocol', () => {
  it('runs query, typed error, and acknowledged stream through JSON frames', async () => {
    const [clientPort, serverPort, states] = makePortPair()
    const harness = makeHarness(clientPort, serverPort)
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(group)
          const answer = yield* client.Query({ value: 'scope' })
          const failure = yield* Effect.exit(client.Fail(undefined))
          const numbers = yield* Stream.runCollect(client.Numbers({ count: 3 }))
          const failureReason = Exit.isFailure(failure) ? Cause.findError(failure.cause) : undefined
          return {
            answer,
            failed: Exit.isFailure(failure),
            failureTag: failureReason && Result.isSuccess(failureReason) ? failureReason.success._tag : undefined,
            failureCode:
              failureReason && Result.isSuccess(failureReason) && 'code' in failureReason.success
                ? failureReason.success.code
                : undefined,
            numbers: Array.from(numbers),
          }
        }),
      ).pipe(Effect.provide(Layer.merge(harness.clientLayer, harness.serverLayer))),
    )

    expect(result.answer).toBe('answer:scope')
    expect(result.failed).toBe(true)
    expect(result.failureTag).toBe('QueryFailure')
    expect(result.failureCode).toBe('expected')
    expect(result.numbers).toEqual([1, 2, 3])
    expect(states[0].sent.every(frame => typeof frame === 'string')).toBe(true)
    expect(JSON.parse(states[0].sent[0] ?? '{}')).toMatchObject({ _tag: 'Request', tag: 'Query' })
    expect(states[0].sent.some(frame => JSON.parse(frame)._tag === 'Ack')).toBe(true)
  })

  it('sanitizes defects on the RPC boundary while preserving typed failures', async () => {
    const [clientPort, serverPort, states] = makePortPair()
    const harness = makeHarness(clientPort, serverPort)
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(group)
          const failure = yield* Effect.exit(client.Defect(undefined))
          return Exit.isFailure(failure) ? Cause.pretty(failure.cause) : 'unexpected success'
        }),
      ).pipe(Effect.provide(Layer.merge(harness.clientLayer, harness.serverLayer))),
    )

    expect(result).toContain('RPC server failure')
    expect(result).not.toContain('secret')
    expect(result).not.toContain('ledger.db')
    const serverFrames = states[1].sent.join('\n')
    expect(serverFrames).not.toContain('secret')
    expect(serverFrames).not.toContain('ledger.db')
    expect(serverFrames).toContain('RPC server failure')
  })

  it('sends an interrupt when a client call is interrupted', async () => {
    const [clientPort, serverPort, states] = makePortPair()
    const harness = makeHarness(clientPort, serverPort)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(group)
          const request = yield* Effect.forkChild(client.Wait(undefined))
          yield* Deferred.await(harness.started)
          yield* Fiber.interrupt(request)
          yield* Effect.yieldNow
        }),
      ).pipe(Effect.provide(Layer.merge(harness.clientLayer, harness.serverLayer))),
    )
    expect(states[0].sent.some(frame => JSON.parse(frame)._tag === 'Interrupt')).toBe(true)
    expect(harness.waitInterrupted()).toBe(true)
  })

  it('fails pending work on malformed server frames and disposes subscriptions once', async () => {
    const [clientPort, serverPort, states] = makePortPair()
    const harness = makeHarness(clientPort, serverPort)
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(group)
          const pending = yield* Effect.forkChild(Effect.exit(client.Wait(undefined)))
          yield* Deferred.await(harness.started)
          yield* serverPort.send('{ malformed')
          const result = yield* Fiber.join(pending)
          return Exit.isFailure(result) ? 'Failure' : 'Success'
        }),
      ).pipe(Effect.provide(Layer.merge(harness.clientLayer, harness.serverLayer))),
    )

    expect(outcome).toBe('Failure')
    expect(harness.noopCalls()).toBe(0)
    expect(states[0].removals).toBe(2)
    expect(states[1].removals).toBe(2)
  })

  it('fails an in-flight call when the peer closes the port', async () => {
    const [clientPort, serverPort, states] = makePortPair()
    const harness = makeHarness(clientPort, serverPort)
    const disconnected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(group)
          const pending = yield* Effect.forkChild(Effect.exit(client.Wait(undefined)))
          yield* Deferred.await(harness.started)
          yield* serverPort.close()
          return Exit.isFailure(yield* Fiber.join(pending))
        }),
      ).pipe(Effect.provide(Layer.merge(harness.clientLayer, harness.serverLayer))),
    )

    expect(disconnected).toBe(true)
    expect(states[0].sent.filter(frame => JSON.parse(frame).tag === 'Wait')).toHaveLength(1)
  })

  it('fails pending calls when the local endpoint closes', async () => {
    const [clientPort, serverPort] = makePortPair()
    const harness = makeHarness(clientPort, serverPort)
    const disconnected = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(group)
          const pending = yield* Effect.forkChild(Effect.exit(client.Wait(undefined)))
          yield* Deferred.await(harness.started)
          yield* clientPort.close()
          return Exit.isFailure(yield* Fiber.join(pending))
        }),
      ).pipe(Effect.provide(Layer.merge(harness.clientLayer, harness.serverLayer))),
    )

    expect(disconnected).toBe(true)
  })

  it('settles pending calls when the bounded inbox overflows', async () => {
    const [clientPort, serverPort, states] = makePortPair()
    const harness = makeHarness(clientPort, serverPort)
    const overflowed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(group)
          const pending = yield* Effect.forkChild(Effect.exit(client.Wait(undefined)))
          yield* Deferred.await(harness.started)
          yield* Effect.sync(() => {
            for (let index = 0; index < 128; index++) {
              for (const receive of states[0].receive) receive('{"_tag":"Pong"}')
            }
          })
          return Exit.isFailure(yield* Fiber.join(pending))
        }),
      ).pipe(Effect.provide(Layer.merge(harness.clientLayer, harness.serverLayer))),
    )

    expect(overflowed).toBe(true)
  })

  it('rejects malformed Exit envelopes without defecting the RPC client', async () => {
    const [clientPort, serverPort, states] = makePortPair()
    const harness = makeHarness(clientPort, serverPort)
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(group)
          const pending = yield* Effect.forkChild(Effect.exit(client.Wait(undefined)))
          yield* Deferred.await(harness.started)
          const request = states[0].sent.map(frame => JSON.parse(frame)).find(frame => frame.tag === 'Wait')
          if (!request) throw new Error('Wait request frame was not sent')
          yield* serverPort.send(JSON.stringify({ _tag: 'Exit', requestId: request.id, exit: { _tag: 'Unknown' } }))
          const exit = yield* Fiber.join(pending)
          if (!Exit.isFailure(exit)) return false
          const failure = Cause.findError(exit.cause)
          return Result.isSuccess(failure) && failure.success._tag === 'RpcClientError'
        }),
      ).pipe(Effect.provide(Layer.merge(harness.clientLayer, harness.serverLayer))),
    )

    expect(result).toBe(true)
  })

  it('rejects malformed client frames before invoking a handler', async () => {
    const [clientPort, serverPort] = makePortPair()
    const harness = makeHarness(clientPort, serverPort)
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(group)
          yield* clientPort.send('{ malformed')
          yield* Effect.sleep('10 millis')
          const exit = yield* Effect.exit(client.Noop(undefined))
          return Exit.isFailure(exit)
        }),
      ).pipe(Effect.provide(Layer.merge(harness.clientLayer, harness.serverLayer))),
    )

    expect(outcome).toBe(true)
    expect(harness.noopCalls()).toBe(0)
  })
})
