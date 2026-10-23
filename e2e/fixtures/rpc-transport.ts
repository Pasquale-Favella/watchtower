import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { RpcClient } from 'effect/rpc'
import type { RpcClientError } from 'effect/rpc/RpcClientError'
import * as Stream from 'effect/Stream'

import { rpcMessagePortFromBridge } from '../../src/renderer/src/shared/lib/rpc-port.js'
import type { RpcBridge } from '../../src/shared/rpc/bridge.js'
import { clientProtocolLayer } from '../../src/shared/rpc/port-protocol.js'
import { ProbeRpcGroup } from './rpc-transport-contract.js'

type ProbeClient = RpcClient.FromGroup<typeof ProbeRpcGroup, RpcClientError>
type FixtureApi = {
  readonly rpcV1: RpcBridge
}
type ProbeGlobal = {
  readonly run: <A, E>(operation: (client: ProbeClient, generation: number) => Effect.Effect<A, E>) => Promise<A>
  readonly read: () => Promise<{ readonly writes: number }>
  readonly write: (value: string) => Promise<unknown>
  readonly fail: () => Promise<unknown>
  readonly finiteStream: () => Promise<number[]>
  readonly slowStream: () => Promise<number[]>
  readonly beginLostAck: () => Promise<number>
  readonly finishLostAck: () => Promise<string>
  readonly disconnect: (generation: number) => void
  readonly raw: (frame: string) => Promise<{ readonly generation: number; readonly closed: boolean }>
  readonly overflow: () => Promise<{ readonly generation: number; readonly closed: boolean }>
  readonly connect: () => Promise<unknown>
  readonly beginConnect: () => void
  readonly bridge: () => RpcBridge
}

const w = window as typeof window & { api?: FixtureApi; rpcTransportProbe?: ProbeGlobal }
let pendingWrite: Promise<unknown> | undefined

const bridge = (): RpcBridge => {
  const value = w.api?.rpcV1
  if (!value) throw new Error('RPC preload bridge is unavailable')
  return value
}

const run = async <A, E>(operation: (client: ProbeClient, generation: number) => Effect.Effect<A, E>): Promise<A> => {
  const rpcBridge = bridge()
  const connection = await rpcBridge.connect()
  if (connection._tag !== 'Connected') throw new Error(`connect failed: ${connection.code}`)
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const protocol = yield* Layer.build(
          clientProtocolLayer(rpcMessagePortFromBridge(rpcBridge, connection.generation)),
        )
        const client = yield* RpcClient.make(ProbeRpcGroup).pipe(
          Effect.provideService(RpcClient.Protocol, Context.get(protocol, RpcClient.Protocol)),
        )
        return yield* operation(client, connection.generation)
      }),
    ),
  )
}

w.rpcTransportProbe = {
  run,
  bridge,
  connect: () => bridge().connect(),
  beginConnect: () => {
    void bridge().connect()
  },
  read: () => run(client => client['probe:read'](undefined)),
  write: value => run(client => client['probe:write']({ value })),
  fail: () => run(client => client['probe:fail'](undefined)),
  finiteStream: () =>
    run(client => Stream.runCollect(client['probe:finite-stream'](undefined))).then(values => Array.from(values)),
  slowStream: () =>
    run(client =>
      Stream.runCollect(
        Stream.take(client['probe:infinite-stream'](undefined), 1).pipe(Stream.tap(() => Effect.sleep('100 millis'))),
      ),
    ).then(values => Array.from(values)),
  beginLostAck: async () => {
    const rpcBridge = bridge()
    const connection = await rpcBridge.connect()
    if (connection._tag !== 'Connected') throw new Error(`connect failed: ${connection.code}`)
    pendingWrite = Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* Layer.build(
            clientProtocolLayer(rpcMessagePortFromBridge(rpcBridge, connection.generation)),
          )
          const client = yield* RpcClient.make(ProbeRpcGroup).pipe(
            Effect.provideService(RpcClient.Protocol, Context.get(protocol, RpcClient.Protocol)),
          )
          return yield* client['probe:write']({ value: 'commit-then-disconnect' })
        }),
      ),
    )
    return connection.generation
  },
  finishLostAck: async () => {
    if (!pendingWrite) throw new Error('No pending write')
    try {
      await pendingWrite
      return 'Success'
    } catch {
      return 'Failure'
    } finally {
      pendingWrite = undefined
    }
  },
  disconnect: generation => bridge().disconnect(generation),
  raw: async frame => {
    const rpcBridge = bridge()
    const connection = await rpcBridge.connect()
    if (connection._tag !== 'Connected') throw new Error(`connect failed: ${connection.code}`)
    let closed = false
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe()
        reject(new Error('RPC port did not close'))
      }, 3000)
      const unsubscribe = rpcBridge.onClose(() => {
        closed = true
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      }, connection.generation)
      void rpcBridge.send(frame, connection.generation).catch(reject)
    })
    return { generation: connection.generation, closed }
  },
  overflow: async () => {
    const rpcBridge = bridge()
    const connection = await rpcBridge.connect()
    if (connection._tag !== 'Connected') throw new Error(`connect failed: ${connection.code}`)
    let closed = false
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe()
        reject(new Error('RPC inbox did not close after overflow'))
      }, 3000)
      const unsubscribe = rpcBridge.onClose(() => {
        closed = true
        clearTimeout(timeout)
        unsubscribe()
        resolve()
      }, connection.generation)
      for (let index = 0; index < 10_000; index += 1) {
        void rpcBridge.send('{"_tag":"Ping"}', connection.generation).catch(reject)
      }
    })
    return { generation: connection.generation, closed }
  },
}

document.documentElement.dataset.ready = 'true'
