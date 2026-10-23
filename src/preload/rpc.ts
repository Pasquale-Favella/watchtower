import * as Schema from 'effect/Schema'

import {
  type RpcBridge,
  type RpcConnectionRequest,
  RpcConnectionRequestSchema,
  RpcConnectionResponseSchema,
  type RpcConnectionResult,
} from '../shared/rpc/bridge.js'

const CONNECT_CHANNEL = 'rpc:v1:connect'
const PORT_CHANNEL = 'rpc:v1:port'

interface RpcPreloadPort {
  postMessage: (message: string) => void
  start: () => void
  close: () => void
  addEventListener: (type: 'message' | 'close' | 'messageerror', listener: (event: { data?: unknown }) => void) => void
  removeEventListener: (
    type: 'message' | 'close' | 'messageerror',
    listener: (event: { data?: unknown }) => void,
  ) => void
}

interface RpcPreloadEvent {
  readonly ports?: readonly RpcPreloadPort[]
}

interface RpcIpcRenderer {
  readonly send: (channel: typeof CONNECT_CHANNEL, request: RpcConnectionRequest) => void
  readonly on: (channel: typeof PORT_CHANNEL, listener: (event: RpcPreloadEvent, data: unknown) => void) => void
  readonly removeListener: (
    channel: typeof PORT_CHANNEL,
    listener: (event: RpcPreloadEvent, data: unknown) => void,
  ) => void
}

interface PendingConnection {
  readonly requestId: number
  readonly resolve: (result: RpcConnectionResult) => void
  readonly promise: Promise<RpcConnectionResult>
  readonly timeout: ReturnType<typeof setTimeout>
}

interface ActiveConnection {
  readonly port: RpcPreloadPort
  readonly generation: number
  readonly onMessage: (event: { data?: unknown }) => void
  readonly onClose: (event: { data?: unknown }) => void
}

/** Builds the fixed preload capability. It never returns the Electron port or IPC object. */
export const createRpcBridge = (
  ipc: RpcIpcRenderer,
  connectionTimeoutMs = 10_000,
): {
  readonly bridge: RpcBridge
  readonly dispose: () => void
} => {
  let nextRequestId = 1
  let pending: PendingConnection | undefined
  let active: ActiveConnection | undefined
  let disposed = false
  let disposeTimer: ReturnType<typeof setTimeout> | undefined
  const cancelledRequests = new Set<number>()
  let listenerAttached = false
  const messageListeners = new Set<{ readonly generation: number; readonly receive: (frame: unknown) => void }>()
  const closeListeners = new Set<{ readonly generation: number; readonly close: () => void }>()

  const notifyClosed = (generation: number): void => {
    for (const listener of [...closeListeners]) if (listener.generation === generation) listener.close()
  }

  const closeActive = (notify: boolean): void => {
    const connection = active
    if (!connection) return
    active = undefined
    connection.port.removeEventListener('message', connection.onMessage)
    connection.port.removeEventListener('close', connection.onClose)
    connection.port.removeEventListener('messageerror', connection.onClose)
    connection.port.close()
    if (notify) notifyClosed(connection.generation)
  }

  const onPort = (event: RpcPreloadEvent, raw: unknown): void => {
    const port = event.ports?.[0]
    let data: Schema.Schema.Type<typeof RpcConnectionResponseSchema>
    try {
      data = Schema.decodeUnknownSync(RpcConnectionResponseSchema)(raw)
    } catch {
      port?.close()
      if (disposed) detachListener()
      return
    }
    const request = pending
    if (cancelledRequests.delete(data.requestId)) {
      port?.close()
      if (disposed && cancelledRequests.size === 0) detachListener()
      return
    }
    if (!request || request.requestId !== data.requestId) {
      port?.close()
      if (disposed) detachListener()
      return
    }
    if (data._tag === 'Rejected') {
      pending = undefined
      clearTimeout(request.timeout)
      port?.close()
      request.resolve({ _tag: 'Failed', code: data.code })
      return
    }
    if (!port) {
      pending = undefined
      clearTimeout(request.timeout)
      request.resolve({ _tag: 'Failed', code: 'protocol' })
      return
    }

    closeActive(false)
    const connection: ActiveConnection = {
      port,
      generation: data.generation,
      onMessage: message => {
        for (const listener of [...messageListeners])
          if (listener.generation === connection.generation) listener.receive(message.data)
      },
      onClose: () => {
        if (active !== connection) return
        closeActive(true)
      },
    }
    active = connection
    port.addEventListener('message', connection.onMessage)
    port.addEventListener('close', connection.onClose)
    port.addEventListener('messageerror', connection.onClose)
    port.start()
    pending = undefined
    clearTimeout(request.timeout)
    request.resolve({ _tag: 'Connected', generation: connection.generation })
  }

  const detachListener = (): void => {
    if (!listenerAttached) return
    listenerAttached = false
    if (disposeTimer) clearTimeout(disposeTimer)
    disposeTimer = undefined
    ipc.removeListener(PORT_CHANNEL, onPort)
  }

  ipc.on(PORT_CHANNEL, onPort)
  listenerAttached = true

  const bridge: RpcBridge = {
    connect: () => {
      if (disposed) return Promise.resolve({ _tag: 'Failed', code: 'closed' })
      if (active) return Promise.resolve({ _tag: 'Connected', generation: active.generation })
      if (pending) return pending.promise
      let resolve!: (result: RpcConnectionResult) => void
      const promise = new Promise<RpcConnectionResult>(res => {
        resolve = res
      })
      const requestId = nextRequestId++
      const timeout = setTimeout(() => {
        if (pending?.requestId !== requestId) return
        pending = undefined
        resolve({ _tag: 'Failed', code: 'unavailable' })
      }, connectionTimeoutMs)
      const request: PendingConnection = { requestId, resolve, promise, timeout }
      pending = request
      try {
        ipc.send(CONNECT_CHANNEL, Schema.decodeUnknownSync(RpcConnectionRequestSchema)({ version: 1, requestId }))
      } catch {
        pending = undefined
        clearTimeout(timeout)
        resolve({ _tag: 'Failed', code: 'unavailable' })
      }
      return promise
    },
    send: (frame, generation) => {
      const connection = active
      if (disposed || !connection || connection.generation !== generation)
        return Promise.reject(new Error('RPC connection unavailable'))
      try {
        connection.port.postMessage(frame)
        return Promise.resolve()
      } catch {
        closeActive(true)
        return Promise.reject(new Error('RPC send failed'))
      }
    },
    onMessage: (receive, generation) => {
      const listener = { generation, receive }
      messageListeners.add(listener)
      return () => {
        messageListeners.delete(listener)
      }
    },
    onClose: (close, generation) => {
      if (active?.generation !== generation) {
        close()
        return () => undefined
      }
      const listener = { generation, close }
      closeListeners.add(listener)
      return () => {
        closeListeners.delete(listener)
      }
    },
    disconnect: generation => {
      if (active?.generation === generation) closeActive(true)
    },
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (pending) {
      clearTimeout(pending.timeout)
      cancelledRequests.add(pending.requestId)
      pending.resolve({ _tag: 'Failed', code: 'closed' })
      pending = undefined
    }
    if (cancelledRequests.size > 0) {
      disposeTimer = setTimeout(() => {
        cancelledRequests.clear()
        disposeTimer = undefined
        detachListener()
      }, connectionTimeoutMs)
    } else {
      detachListener()
    }
    closeActive(true)
    messageListeners.clear()
    closeListeners.clear()
  }
  return { bridge, dispose }
}
