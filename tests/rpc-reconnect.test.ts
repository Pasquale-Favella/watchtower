import * as Context from 'effect/Context'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as AtomRpc from 'effect/reactivity/AtomRpc'
import { Rpc, RpcClient, RpcGroup } from 'effect/rpc'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as Result from 'effect/Result'
import { describe, expect, it } from 'vitest'

import type { RpcBridge } from '../src/shared/rpc/bridge.js'
import { reconnectingRendererProtocolLayer, RendererConnection } from '../src/shared/rpc/reconnecting-protocol.js'

const Read = Rpc.make('Read', { success: Schema.String })
const Write = Rpc.make('Write', { payload: { value: Schema.String }, success: Schema.Void })
const Wait = Rpc.make('Wait', { success: Schema.String })
const Group = RpcGroup.make(Read, Write, Wait)

interface Generation {
  readonly messages: Set<(frame: unknown) => void>
  readonly closes: Set<() => void>
  closed: boolean
}

const makeBridge = (
  options: { readonly failAttempts?: ReadonlyArray<number>; readonly holdAttempts?: ReadonlyArray<number> } = {},
) => {
  const generations = new Map<number, Generation>()
  const ready = new Map<number, () => void>()
  const connectReady = new Map<number, () => void>()
  const received = new Map<string, Array<() => void>>()
  const disconnectWaiters: Array<() => void> = []
  const seen = new Set<string>()
  let nextGeneration = 1
  let connectAttempts = 0
  let writes = 0
  let reads = 0
  let interrupts = 0
  let disconnects = 0

  const signal = (key: string) => {
    seen.add(key)
    const callbacks = received.get(key)
    if (!callbacks) return
    received.delete(key)
    for (const callback of callbacks) callback()
  }
  const waitFor = (key: string) =>
    seen.has(key)
      ? Promise.resolve()
      : new Promise<void>(resolve => {
          const callbacks = received.get(key) ?? []
          callbacks.push(resolve)
          received.set(key, callbacks)
        })
  const waitForConnectAttempts = (count: number) =>
    connectAttempts >= count ? Promise.resolve() : new Promise<void>(resolve => connectReady.set(count, resolve))
  const nextConnected = (): { readonly _tag: 'Connected'; readonly generation: number } => {
    const generation = nextGeneration++
    generations.set(generation, { messages: new Set(), closes: new Set(), closed: false })
    const resolve = ready.get(generation)
    ready.delete(generation)
    resolve?.()
    return { _tag: 'Connected', generation }
  }
  const close = (generation: number) => {
    const state = generations.get(generation)
    if (!state || state.closed) return
    state.closed = true
    for (const listener of [...state.closes]) listener()
  }
  const bridge: RpcBridge = {
    connect: async () => {
      const attempt = ++connectAttempts
      const readyForAttempt = connectReady.get(connectAttempts)
      if (readyForAttempt) {
        connectReady.delete(connectAttempts)
        readyForAttempt()
      }
      if (options.failAttempts?.includes(attempt)) return { _tag: 'Failed', code: 'unavailable' }
      if (options.holdAttempts?.includes(attempt)) {
        return new Promise(resolve => connectReady.set(-attempt, () => resolve(nextConnected())))
      }
      return nextConnected()
    },
    send: async (frame, generation) => {
      const state = generations.get(generation)
      if (!state || state.closed) throw new Error('closed')
      const message = JSON.parse(frame) as { _tag: string; tag?: string; id?: string | number }
      if (message._tag === 'Interrupt') interrupts += 1
      if (message._tag !== 'Request' || message.id === undefined || !message.tag) return
      if (message.tag === 'Write') writes += 1
      if (message.tag === 'Read') reads += 1
      signal(`${generation}:${message.tag}`)
      if (message.tag === 'Wait' || message.tag === 'Write') return
      const response = {
        _tag: 'Exit',
        requestId: message.id,
        exit: { _tag: 'Success', value: message.tag === 'Read' ? `generation-${generation}` : undefined },
      }
      for (const listener of state.messages) listener(JSON.stringify(response))
    },
    onMessage: (listener, generation) => {
      const state = generations.get(generation)
      if (!state) return () => undefined
      state.messages.add(listener)
      return () => state.messages.delete(listener)
    },
    onClose: (listener, generation) => {
      const state = generations.get(generation)
      if (!state || state.closed) {
        listener()
        return () => undefined
      }
      state.closes.add(listener)
      return () => state.closes.delete(listener)
    },
    disconnect: generation => {
      disconnects += 1
      close(generation)
      for (const resolve of disconnectWaiters.splice(0)) resolve()
    },
  }
  return {
    bridge,
    close,
    waitFor,
    waitConnected: (generation: number) =>
      generations.has(generation) ? Promise.resolve() : new Promise<void>(resolve => ready.set(generation, resolve)),
    waitForConnectAttempts,
    releaseConnect: (attempt: number) => {
      const release = connectReady.get(-attempt)
      if (release) {
        connectReady.delete(-attempt)
        release()
      }
    },
    waitForDisconnect: (count: number) =>
      disconnects >= count ? Promise.resolve() : new Promise<void>(resolve => disconnectWaiters.push(resolve)),
    sendMalformed: (generation: number) => {
      const state = generations.get(generation)
      if (!state) throw new Error(`Unknown generation ${generation}`)
      for (const listener of [...state.messages]) listener('{ malformed')
    },
    connectAttempts: () => connectAttempts,
    counts: () => ({ writes, reads, disconnects, interrupts }),
    handlers: (generation: number) => {
      const state = generations.get(generation)
      return (state?.messages.size ?? 0) + (state?.closes.size ?? 0)
    },
  }
}

const protocolLayer = (
  bridge: RpcBridge,
  options: { readonly initialRetryDelayMs?: number; readonly maxRetryDelayMs?: number } = {},
) => reconnectingRendererProtocolLayer(bridge, { initialRetryDelayMs: 1, ...options })
const awaitGeneration = (transport: ReturnType<typeof makeBridge>, generation: number) =>
  Effect.andThen(
    Effect.promise(() => transport.waitConnected(generation)),
    Effect.sleep('1 millis'),
  )

const failureTag = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return undefined
  const error = Cause.findError(exit.cause)
  return Result.isSuccess(error) &&
    typeof error.success === 'object' &&
    error.success !== null &&
    '_tag' in error.success
    ? error.success._tag
    : undefined
}

describe('reconnecting Effect RPC protocol', () => {
  it('fails admitted work on disconnect and uses the replacement for future calls without replay', async () => {
    const transport = makeBridge()
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(Group)
          yield* awaitGeneration(transport, 1)
          const pending = yield* Effect.forkChild(Effect.exit(client.Write({ value: 'commit-once' })))
          yield* Effect.promise(() => transport.waitFor('1:Write'))
          transport.close(1)
          const failed = yield* Fiber.join(pending)
          yield* awaitGeneration(transport, 2)
          const future = yield* client.Read(undefined)
          return { failed: Exit.isFailure(failed), failureTag: failureTag(failed), future }
        }),
      ).pipe(Effect.provide(protocolLayer(transport.bridge))),
    )

    expect(outcome).toEqual({ failed: true, failureTag: 'RpcClientError', future: 'generation-2' })
    expect(transport.counts().writes).toBe(1)
    expect(transport.counts().reads).toBe(1)
  })

  it('reuses one protocol through repeated generations and removes handlers on scope disposal', async () => {
    const transport = makeBridge()
    const before = transport.handlers(1)
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(Group)
          yield* awaitGeneration(transport, 1)
          yield* client.Read(undefined)
          transport.close(1)
          yield* awaitGeneration(transport, 2)
          yield* client.Read(undefined)
          transport.close(2)
          yield* awaitGeneration(transport, 3)
          yield* client.Read(undefined)
          expect(transport.counts().reads).toBe(3)
        }),
      ).pipe(Effect.provide(protocolLayer(transport.bridge))),
    )

    expect(before).toBe(0)
    expect(transport.handlers(1)).toBe(0)
    expect(transport.handlers(2)).toBe(0)
    expect(transport.handlers(3)).toBe(0)
    expect(transport.counts().disconnects).toBeGreaterThanOrEqual(3)
  })

  it('publishes bounded latest readiness state and does not reconnect after scoped disposal', async () => {
    const transport = makeBridge()
    const states = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* RendererConnection
          const first = yield* connection.current
          const observed = yield* Stream.runCollect(connection.changes.pipe(Stream.take(2)))
          const current = yield* connection.current
          return { current: [first._tag, current._tag], observed: Array.from(observed, value => value._tag) }
        }),
      ).pipe(Effect.provide(protocolLayer(transport.bridge))),
    )
    expect(states.current).toEqual(['Connecting', 'Connected'])
    expect(states.observed).toEqual(['Connecting', 'Connected'])
    expect(transport.handlers(1)).toBe(0)
    expect(transport.handlers(2)).toBe(0)
  })

  it('does not replay a mounted native AtomRpc mutation after the connection heals', async () => {
    const transport = makeBridge()
    const registry = AtomRegistry.make()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const services = yield* Layer.build(protocolLayer(transport.bridge))
          const protocol = Context.get(services, RpcClient.Protocol)
          yield* Effect.promise(() => transport.waitConnected(1))
          yield* Effect.sleep('1 millis')
          const client = AtomRpc.Service<object>()('test/reconnecting-AtomRpc', {
            group: Group,
            protocol: Layer.succeed(RpcClient.Protocol, protocol),
            runtime: Atom.context(),
          })
          const mutation = client.mutation('Write')
          const unmount = registry.mount(mutation)
          registry.set(mutation, { payload: { value: 'last-argument' } })
          yield* Effect.promise(() => transport.waitFor('1:Write'))
          transport.close(1)
          yield* Effect.promise(() => transport.waitConnected(2))
          yield* Effect.sleep('5 millis')
          expect(transport.counts().writes).toBe(1)
          expect(transport.counts().disconnects).toBe(1)
          unmount()
          registry.dispose()
        }),
      ),
    )
  })

  it('sends cancellation to the current generation and disposes all handlers', async () => {
    const transport = makeBridge()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(Group)
          yield* awaitGeneration(transport, 1)
          const pending = yield* Effect.forkChild(client.Wait(undefined))
          yield* Effect.promise(() => transport.waitFor('1:Wait'))
          yield* Fiber.interrupt(pending)
        }),
      ).pipe(Effect.provide(protocolLayer(transport.bridge))),
    )

    expect(transport.counts().interrupts).toBe(1)
    expect(transport.handlers(1)).toBe(0)
  })

  it('fails pending calls on malformed input, closes only that generation, and heals', async () => {
    const transport = makeBridge()
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(Group)
          yield* awaitGeneration(transport, 1)
          const pending = yield* Effect.forkChild(Effect.exit(client.Wait(undefined)))
          yield* Effect.promise(() => transport.waitFor('1:Wait'))
          transport.sendMalformed(1)
          const failed = yield* Fiber.join(pending)
          yield* awaitGeneration(transport, 2)
          const future = yield* client.Read(undefined)
          return {
            failed: Exit.isFailure(failed),
            failureTag: failureTag(failed),
            future,
            replacementHandlers: transport.handlers(2),
          }
        }),
      ).pipe(Effect.provide(protocolLayer(transport.bridge))),
    )

    expect(outcome).toMatchObject({ failed: true, failureTag: 'RpcClientError', future: 'generation-2' })
    expect(outcome.replacementHandlers).toBeGreaterThan(0)
    expect(transport.handlers(1)).toBe(0)
    expect(transport.handlers(2)).toBe(0)
  })

  it('retries a failed readiness handshake and publishes its failure state', async () => {
    const transport = makeBridge({ failAttempts: [1] })
    const states = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* RendererConnection
          const failure = yield* connection.changes.pipe(
            Stream.filter(state => state._tag === 'Failed'),
            Stream.runHead,
          )
          yield* awaitGeneration(transport, 1)
          const client = yield* RpcClient.make(Group)
          const future = yield* client.Read(undefined)
          return { failure: failure._tag, future }
        }),
      ).pipe(Effect.provide(protocolLayer(transport.bridge, { initialRetryDelayMs: 10 }))),
    )

    expect(states).toEqual({ failure: 'Some', future: 'generation-1' })
    expect(transport.connectAttempts()).toBe(2)
  })

  it('disconnects a readiness handshake that resolves after scope disposal', async () => {
    const transport = makeBridge({ holdAttempts: [1] })
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(protocolLayer(transport.bridge))
          yield* Effect.promise(() => transport.waitForConnectAttempts(1))
        }),
      ),
    )
    transport.releaseConnect(1)
    await transport.waitConnected(1)
    await transport.waitForDisconnect(1)

    expect(transport.handlers(1)).toBe(0)
    expect(transport.connectAttempts()).toBe(1)
  })
})
