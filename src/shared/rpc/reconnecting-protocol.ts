import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as PubSub from 'effect/PubSub'
import { RpcClient, RpcSerialization } from 'effect/rpc'
import { RpcClientDefect, RpcClientError } from 'effect/rpc/RpcClientError'
import * as Scope from 'effect/Scope'
import * as Stream from 'effect/Stream'

import type { RpcBridge } from '@/shared/rpc/bridge.js'
import { clientProtocolLayer, type RpcMessagePort, RpcPortError } from '@/shared/rpc/port-protocol.js'

export type RendererConnectionState =
  | { readonly _tag: 'Connecting' }
  | { readonly _tag: 'Connected'; readonly generation: number }
  | { readonly _tag: 'Disconnected'; readonly reason: string }
  | { readonly _tag: 'Failed'; readonly reason: string }

export class RendererConnection extends Context.Service<
  RendererConnection,
  {
    readonly current: Effect.Effect<RendererConnectionState>
    readonly changes: Stream.Stream<RendererConnectionState>
  }
>()('watchtower/shared/rpc/RendererConnection') {}

export interface ReconnectingProtocolOptions {
  readonly initialRetryDelayMs?: number
  readonly maxRetryDelayMs?: number
}

interface GenerationProtocol {
  readonly generation: number
  readonly scope: Scope.Closeable
  readonly protocol: RpcClient.Protocol['Service']
  readonly disconnected: Deferred.Deferred<undefined>
  readonly clients: Set<number>
  readonly lifecycle: { closed: boolean; disconnectRequested: boolean }
}

const connectionError = (message: string, cause: unknown): RpcClientError =>
  new RpcClientError({ reason: new RpcClientDefect({ message, cause }) })

const isSameConnectionState = (left: RendererConnectionState, right: RendererConnectionState): boolean => {
  switch (right._tag) {
    case 'Connecting':
      return left._tag === 'Connecting'
    case 'Connected':
      return left._tag === 'Connected' && left.generation === right.generation
    case 'Disconnected':
      return left._tag === 'Disconnected' && left.reason === right.reason
    case 'Failed':
      return left._tag === 'Failed' && left.reason === right.reason
  }
}

const disconnectBridge = (bridge: RpcBridge, generation: number): void => {
  try {
    bridge.disconnect(generation)
  } catch {
    // The preload bridge may already have closed this generation.
  }
}

const portForGeneration = (
  bridge: RpcBridge,
  generation: number,
  disconnected: Deferred.Deferred<undefined>,
  isClosed: () => boolean,
  markDisconnectRequested: () => boolean,
): RpcMessagePort => ({
  send: frame =>
    Effect.tryPromise({
      try: () => bridge.send(frame, generation),
      catch: () => new RpcPortError({ code: 'send-failed' }),
    }),
  subscribe: receive =>
    Effect.sync(() =>
      bridge.onMessage(frame => {
        if (!isClosed()) receive(frame)
      }, generation),
    ),
  subscribeClose: onClose =>
    Effect.sync(() =>
      bridge.onClose(() => {
        if (isClosed()) return
        Deferred.doneUnsafe(disconnected, Effect.succeed(undefined))
        onClose()
      }, generation),
    ),
  close: () =>
    Effect.sync(() => {
      Deferred.doneUnsafe(disconnected, Effect.succeed(undefined))
      if (markDisconnectRequested()) disconnectBridge(bridge, generation)
    }),
})

/**
 * Builds a stable client protocol whose scoped port protocol is replaced on
 * each preload generation. Requests stay bound to the generation that admitted
 * them and the shared port protocol reports disconnect failures to its clients.
 */
export const reconnectingRendererProtocolLayer = (
  bridge: RpcBridge,
  options: ReconnectingProtocolOptions = {},
): Layer.Layer<RpcClient.Protocol | RendererConnection> => {
  const initialRetryDelayMs = options.initialRetryDelayMs ?? 100
  const maxRetryDelayMs = options.maxRetryDelayMs ?? 3_000

  return Layer.effectContext(
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      let state: RendererConnectionState = { _tag: 'Connecting' }
      const stateBus = yield* PubSub.sliding<RendererConnectionState>({ capacity: 1, replay: 1 })
      yield* PubSub.publish(stateBus, state)
      let disposed = false
      let active: GenerationProtocol | undefined
      let failClients: (error: RpcClientError) => Effect.Effect<void> = () => Effect.void

      const publish = Effect.fnUntraced(function* (next: RendererConnectionState) {
        if (isSameConnectionState(state, next)) return
        state = next
        yield* PubSub.publish(stateBus, next)
      })

      const closeGeneration = Effect.fnUntraced(function* (record: GenerationProtocol, reason: string) {
        if (record.lifecycle.closed) return
        record.lifecycle.closed = true
        if (active === record) active = undefined
        yield* failClients(connectionError('RPC port disconnected', new Error(reason)))
        yield* Scope.close(record.scope, Exit.void)
        if (!record.lifecycle.disconnectRequested) {
          record.lifecycle.disconnectRequested = true
          disconnectBridge(bridge, record.generation)
        }
        if (!disposed) yield* publish({ _tag: 'Disconnected', reason })
      })

      const protocol = yield* RpcClient.Protocol.make((writeResponse, clientIds) => {
        failClients = error =>
          Effect.forEach(clientIds, clientId => writeResponse(clientId, { _tag: 'ClientProtocolError', error }), {
            discard: true,
          })
        return Effect.succeed({
          send(clientId, request) {
            const record = active
            if (!record || record.lifecycle.closed) {
              return Effect.fail(connectionError('RPC port disconnected', new Error('No active connection')))
            }
            return Effect.gen(function* () {
              if (!record.clients.has(clientId)) {
                record.clients.add(clientId)
                yield* Effect.forkIn(
                  record.protocol.run(clientId, response => writeResponse(clientId, response)),
                  record.scope,
                  { startImmediately: true },
                )
              }
              if (disposed || active !== record || record.lifecycle.closed) {
                return yield* new RpcClientError({
                  reason: new RpcClientDefect({
                    message: 'RPC port disconnected',
                    cause: new Error('Connection generation changed'),
                  }),
                })
              }
              return yield* record.protocol.send(clientId, request)
            })
          },
          supportsAck: true,
          supportsTransferables: false,
          codecFor: RpcSerialization.json.codecFor,
        })
      })

      const connectOnce = Effect.scoped(
        Effect.gen(function* () {
          const lowerScope = yield* Scope.make()
          yield* Effect.addFinalizer(exit => Scope.close(lowerScope, exit))
          yield* publish({ _tag: 'Connecting' })
          const result = yield* Effect.tryPromise({
            try: signal => {
              const pending = bridge.connect()
              void pending.then(
                late => {
                  if (signal.aborted && late._tag === 'Connected') disconnectBridge(bridge, late.generation)
                },
                () => undefined,
              )
              return pending
            },
            catch: () => ({ _tag: 'Failed', code: 'unavailable' }) as const,
          }).pipe(Effect.catch(failure => Effect.succeed(failure)))
          if (disposed) {
            if (result._tag === 'Connected') disconnectBridge(bridge, result.generation)
            return 'disposed' as const
          }
          if (result._tag !== 'Connected') {
            yield* publish({ _tag: 'Failed', reason: result.code })
            return 'failed' as const
          }

          const disconnected = yield* Deferred.make<undefined>()
          const lifecycle = { closed: false, disconnectRequested: false }
          const port = portForGeneration(
            bridge,
            result.generation,
            disconnected,
            () => lifecycle.closed,
            () => {
              if (lifecycle.disconnectRequested) return false
              lifecycle.disconnectRequested = true
              return true
            },
          )
          const built = yield* Effect.exit(Layer.buildWithScope(clientProtocolLayer(port), lowerScope))
          if (Exit.isFailure(built) || disposed) {
            lifecycle.closed = true
            if (!lifecycle.disconnectRequested) {
              lifecycle.disconnectRequested = true
              disconnectBridge(bridge, result.generation)
            }
            if (disposed) return 'disposed' as const
            yield* publish({ _tag: 'Failed', reason: 'protocol' })
            return 'failed' as const
          }

          const record: GenerationProtocol = {
            generation: result.generation,
            scope: lowerScope,
            protocol: Context.get(built.value, RpcClient.Protocol),
            disconnected,
            clients: new Set(),
            lifecycle,
          }
          active = record
          yield* publish({ _tag: 'Connected', generation: record.generation })
          yield* Deferred.await(record.disconnected)
          yield* closeGeneration(record, 'closed')
          return disposed ? ('disposed' as const) : ('closed' as const)
        }),
      )

      const reconnect = Effect.gen(function* () {
        let failures = 0
        while (!disposed) {
          const result = yield* connectOnce
          if (result === 'disposed' || disposed) return
          const delay = Math.min(maxRetryDelayMs, initialRetryDelayMs * 2 ** Math.min(failures, 8))
          failures += 1
          yield* Effect.sleep(delay)
        }
      })
      const connectionFiber = yield* Effect.forkScoped(reconnect)
      yield* Scope.addFinalizer(
        scope,
        Effect.gen(function* () {
          disposed = true
          const record = active
          if (record) {
            yield* failClients(connectionError('RPC port disconnected', new Error('Connection disposed')))
            record.lifecycle.closed = true
            Deferred.doneUnsafe(record.disconnected, Effect.succeed(undefined))
          }
          yield* Fiber.interrupt(connectionFiber)
          active = undefined
        }),
      )

      return Context.merge(
        Context.make(RpcClient.Protocol, protocol),
        Context.make(
          RendererConnection,
          RendererConnection.of({
            current: Effect.sync(() => state),
            changes: Stream.fromPubSub(stateBus),
          }),
        ),
      )
    }),
  )
}
