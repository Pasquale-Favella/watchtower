import type { RpcBridge } from '../../../../shared/rpc/bridge.js'
import { reconnectingRendererProtocolLayer } from '../../../../shared/rpc/reconnecting-protocol.js'
import { runtime } from '../../app/renderer-runtime.js'
import { createApplicationAtomRpc } from './atom-rpc.js'

const unavailableConnection = { _tag: 'Failed', code: 'unavailable' } as const
const requiredBridge = (): RpcBridge => {
  const bridge = globalThis.window?.api?.rpcV1
  if (!bridge) throw new Error('RPC bridge unavailable')
  return bridge
}

/** Resolves the preload capability only when the reconnecting layer actually connects. */
const rendererBridge: RpcBridge = {
  connect: () => {
    try {
      return globalThis.window?.api?.rpcV1.connect() ?? Promise.resolve(unavailableConnection)
    } catch {
      return Promise.resolve(unavailableConnection)
    }
  },
  send: (frame, generation) => {
    try {
      return requiredBridge().send(frame, generation)
    } catch {
      return Promise.reject(new Error('RPC bridge unavailable'))
    }
  },
  onMessage: (listener, generation) => {
    return requiredBridge().onMessage(listener, generation)
  },
  onClose: (listener, generation) => {
    return requiredBridge().onClose(listener, generation)
  },
  disconnect: generation => {
    try {
      globalThis.window?.api?.rpcV1.disconnect(generation)
    } catch {
      // The preload capability may be absent or already disposed.
    }
  },
}

/** Shared protocol layer for the application client and renderer connection-state consumer. */
export const ApplicationProtocolLayer = reconnectingRendererProtocolLayer(rendererBridge)

/** Stable application client; its AtomRpc runtime is owned by the renderer root. */
export const ApplicationClient = createApplicationAtomRpc(runtime, ApplicationProtocolLayer)
