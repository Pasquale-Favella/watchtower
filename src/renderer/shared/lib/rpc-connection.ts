import type { RpcBridge } from '@/shared/rpc/bridge.js'
import { reconnectingRendererProtocolLayer } from '@/shared/rpc/reconnecting-protocol.js'

const unavailableConnection = { _tag: 'Failed', code: 'unavailable' } as const
const requiredBridge = (): RpcBridge => {
  const bridge = globalThis.window?.api?.rpcV1
  if (!bridge) throw new Error('RPC bridge unavailable')
  return bridge
}

/** Resolves the isolated preload capability when the window's connection starts. */
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
  onMessage: (listener, generation) => requiredBridge().onMessage(listener, generation),
  onClose: (listener, generation) => requiredBridge().onClose(listener, generation),
  disconnect: generation => {
    try {
      globalThis.window?.api?.rpcV1.disconnect(generation)
    } catch {
      // The preload capability may be absent or already disposed.
    }
  },
}

/** Each window shares this layer between its role-specific client and connection observer. */
export const RendererProtocolLayer = reconnectingRendererProtocolLayer(rendererBridge)
