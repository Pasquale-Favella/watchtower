import * as Effect from 'effect/Effect'

import type { RpcBridge } from '@/shared/rpc/bridge.js'
import { type RpcMessagePort, RpcPortError } from '@/shared/rpc/port-protocol.js'

/** Adapts the fixed preload capability to the shared Effect RPC protocol port. */
export const rpcMessagePortFromBridge = (bridge: RpcBridge, generation: number): RpcMessagePort => ({
  send: frame =>
    Effect.tryPromise({
      try: () => bridge.send(frame, generation),
      catch: () => new RpcPortError({ code: 'send-failed' }),
    }),
  subscribe: receive =>
    Effect.sync(() =>
      bridge.onMessage(frame => {
        receive(frame)
      }, generation),
    ),
  subscribeClose: onClose => Effect.sync(() => bridge.onClose(onClose, generation)),
  close: () =>
    Effect.sync(() => {
      try {
        bridge.disconnect(generation)
      } catch {
        // Disconnect is local cleanup; pending operations already fail through the close signal.
      }
    }),
})
