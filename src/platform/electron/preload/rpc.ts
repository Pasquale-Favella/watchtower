import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import type * as Fiber from 'effect/Fiber'
import * as Schema from 'effect/Schema'
import * as Scope from 'effect/Scope'

import {
  type RpcBridge,
  type RpcConnectionRequest,
  RpcConnectionResponseSchema,
  type RpcConnectionResult,
} from '@/shared/rpc/bridge.js'

const CONNECT_CHANNEL = 'rpc:v1:connect'
const PORT_CHANNEL = 'rpc:v1:port'
interface RpcPreloadPort {
  postMessage(message: string): void
  start(): void
  close(): void
  addEventListener(type: 'message' | 'close' | 'messageerror', listener: (event: { data?: unknown }) => void): void
  removeEventListener(type: 'message' | 'close' | 'messageerror', listener: (event: { data?: unknown }) => void): void
}
interface RpcPreloadEvent {
  readonly ports?: readonly RpcPreloadPort[]
}
interface RpcIpcRenderer {
  send(channel: typeof CONNECT_CHANNEL, request: RpcConnectionRequest): void
  on(channel: typeof PORT_CHANNEL, listener: (event: RpcPreloadEvent, data: unknown) => void): void
  removeListener(channel: typeof PORT_CHANNEL, listener: (event: RpcPreloadEvent, data: unknown) => void): void
}
interface PendingConnection {
  readonly requestId: number
  readonly result: Deferred.Deferred<RpcConnectionResult>
  readonly promise: Promise<RpcConnectionResult>
}
interface ActiveConnection {
  readonly port: RpcPreloadPort
  readonly generation: number
  readonly scope: Scope.Closeable
}
const closed: RpcConnectionResult = { _tag: 'Failed', code: 'closed' }
const unavailable: RpcConnectionResult = { _tag: 'Failed', code: 'unavailable' }
/** Native teardown and consumer callbacks cannot prevent remaining cleanup. */
function safely(callback: () => void): void {
  try {
    callback()
  } catch {
    /* Peer or consumer is already gone. */
  }
}

/** Effect owns readiness, deadlines and resources; contextBridge carries values and callbacks. */
export function createRpcBridge(
  ipc: RpcIpcRenderer,
  connectionTimeoutMs = 10_000,
): { readonly bridge: RpcBridge; readonly dispose: () => void } {
  const ipcScope = Scope.makeUnsafe()
  let nextRequestId = 1
  let pending: PendingConnection | undefined
  let active: ActiveConnection | undefined
  let disposed = false
  let disposedRequestId: number | undefined
  let closeGrace: Fiber.Fiber<void> | undefined
  const messageListeners = new Set<{ generation: number; receive: (frame: unknown) => void }>()
  const closeListeners = new Set<{ generation: number; close: () => void }>()
  function detach(): void {
    Effect.runSync(Scope.close(ipcScope, Exit.void))
    closeGrace?.interruptUnsafe()
    closeGrace = undefined
  }
  function complete(request: PendingConnection, result: RpcConnectionResult): void {
    if (pending === request) pending = undefined
    Deferred.doneUnsafe(request.result, Effect.succeed(result))
  }
  function closeActive(): void {
    const connection = active
    if (!connection) return
    active = undefined
    Effect.runSync(Scope.close(connection.scope, Exit.void))
  }
  function closePorts(ports: readonly RpcPreloadPort[] = []): void {
    for (const port of ports) safely(() => port.close())
  }
  function onPort(event: RpcPreloadEvent, raw: unknown): void {
    const decoded = Schema.decodeUnknownResult(RpcConnectionResponseSchema)(raw)
    if (disposed) {
      closePorts(event.ports)
      if (decoded._tag === 'Success' && decoded.success.requestId === disposedRequestId) detach()
      return
    }
    const request = pending
    if (decoded._tag === 'Failure' || !request || decoded.success.requestId !== request.requestId) {
      closePorts(event.ports)
      return
    }
    const response = decoded.success
    if (response._tag === 'Rejected') {
      closePorts(event.ports)
      complete(request, { _tag: 'Failed', code: response.code })
      return
    }
    const [port, ...extra] = event.ports ?? []
    closePorts(extra)
    if (!port) {
      complete(request, { _tag: 'Failed', code: 'protocol' })
      return
    }
    closeActive()
    const connection = { port, generation: response.generation, scope: Scope.makeUnsafe() }
    const onMessage = (message: { data?: unknown }): void => {
      for (const listener of [...messageListeners])
        if (listener.generation === connection.generation) safely(() => listener.receive(message.data))
    }
    const onClose = (): void => {
      if (active === connection) closeActive()
    }
    Effect.runSync(
      Scope.addFinalizer(
        connection.scope,
        Effect.sync(() => {
          safely(() => port.removeEventListener('message', onMessage))
          safely(() => port.removeEventListener('close', onClose))
          safely(() => port.removeEventListener('messageerror', onClose))
          safely(() => port.close())
          for (const listener of [...closeListeners]) {
            if (listener.generation !== connection.generation) continue
            closeListeners.delete(listener)
            safely(listener.close)
          }
          for (const listener of messageListeners)
            if (listener.generation === connection.generation) messageListeners.delete(listener)
        }),
      ),
    )
    active = connection
    try {
      port.addEventListener('message', onMessage)
      port.addEventListener('close', onClose)
      port.addEventListener('messageerror', onClose)
      port.start()
      complete(request, { _tag: 'Connected', generation: connection.generation })
    } catch {
      closeActive()
      complete(request, unavailable)
    }
  }
  Effect.runSync(
    Effect.acquireRelease(
      Effect.sync(() => ipc.on(PORT_CHANNEL, onPort)),
      () => Effect.sync(() => safely(() => ipc.removeListener(PORT_CHANNEL, onPort))),
    ).pipe(Scope.provide(ipcScope)),
  )
  const bridge: RpcBridge = {
    connect: () => {
      if (disposed) return Promise.resolve(closed)
      if (active) return Promise.resolve({ _tag: 'Connected', generation: active.generation })
      if (pending) return pending.promise
      const requestId = nextRequestId++
      const result = Deferred.makeUnsafe<RpcConnectionResult>()
      const promise = Effect.runPromise(
        Deferred.await(result).pipe(
          Effect.timeoutOrElse({ duration: connectionTimeoutMs, orElse: () => Effect.succeed(unavailable) }),
          Effect.tap(() =>
            Effect.sync(() => {
              if (pending?.result === result) pending = undefined
            }),
          ),
        ),
      )
      const request = { requestId, result, promise }
      pending = request
      try {
        ipc.send(CONNECT_CHANNEL, { version: 1, requestId })
      } catch {
        complete(request, unavailable)
      }
      return promise
    },
    send: (frame, generation) => {
      const connection = active
      if (disposed || !connection || connection.generation !== generation)
        return Promise.reject(new Error('RPC connection unavailable'))
      return Effect.runPromise(
        Effect.try({ try: () => connection.port.postMessage(frame), catch: () => new Error('RPC send failed') }).pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              if (active === connection) closeActive()
            }),
          ),
        ),
      )
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
        safely(close)
        return () => undefined
      }
      const listener = { generation, close }
      closeListeners.add(listener)
      return () => {
        closeListeners.delete(listener)
      }
    },
    disconnect: generation => {
      if (active?.generation === generation) closeActive()
    },
  }
  function dispose(): void {
    if (disposed) return
    disposed = true
    const request = pending
    disposedRequestId = request?.requestId
    if (request) complete(request, closed)
    closeActive()
    messageListeners.clear()
    closeListeners.clear()
    if (!request) detach()
    else closeGrace = Effect.runFork(Effect.sleep(connectionTimeoutMs).pipe(Effect.andThen(Effect.sync(detach))))
  }
  return { bridge, dispose }
}
