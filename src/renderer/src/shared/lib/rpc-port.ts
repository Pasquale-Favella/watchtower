import * as Effect from 'effect/Effect'

import type { RpcBridge } from '../../../../shared/rpc/bridge.js'
import { type RpcMessagePort, RpcPortError } from '../../../../shared/rpc/port-protocol.js'

/** Adapts the fixed preload capability to the shared Effect RPC protocol port. */
export const rpcMessagePortFromBridge = (bridge: RpcBridge): RpcMessagePort => ({
  send: frame =>
    Effect.tryPromise({
      try: () => bridge.send(frame),
      catch: () => new RpcPortError({ code: 'send-failed' }),
    }),
  subscribe: receive =>
    Effect.sync(() =>
      bridge.onMessage(frame => {
        receive(frame)
      }),
    ),
  subscribeClose: onClose => Effect.sync(() => bridge.onClose(onClose)),
  close: () =>
    Effect.sync(() => {
      try {
        bridge.disconnect()
      } catch {
        // Disconnect is local cleanup; pending operations already fail through the close signal.
      }
    }),
})
