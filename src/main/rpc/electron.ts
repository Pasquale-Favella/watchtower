import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import type { IpcMain, IpcMainEvent, MessagePortMain, WebContents } from 'electron'
import { MessageChannelMain } from 'electron'

import { RpcConnectionRequestSchema, RpcConnectionResponseSchema } from '../../shared/rpc/bridge.js'
import { type RpcMessagePort, RpcPortError } from '../../shared/rpc/port-protocol.js'

const CONNECT_CHANNEL = 'rpc:v1:connect'
const PORT_CHANNEL = 'rpc:v1:port'
const PROTOCOL_VERSION = 1

export type RpcWindowRole = 'app' | 'beacon' | 'panel'

export interface RpcSenderContext {
  readonly webContents: WebContents
  readonly frame: NonNullable<IpcMainEvent['senderFrame']>
  readonly url: string
}

export interface RegisterElectronRpcOptions {
  readonly ipcMain: Pick<IpcMain, 'on' | 'removeListener'>
  /** Must accept only known windows and their expected app document URL. */
  readonly resolveRole: (sender: RpcSenderContext) => RpcWindowRole | undefined
  /** Installs the existing main-runtime server and returns its scoped teardown. */
  readonly onConnection: (port: RpcMessagePort, role: RpcWindowRole, webContents: WebContents) => () => void
  readonly createChannel?: () => { readonly port1: MessagePortMain; readonly port2: MessagePortMain }
}

interface NativeConnection {
  readonly sender: WebContents
  readonly generation: number
  readonly port: MessagePortMain
  readonly rpcPort: RpcMessagePort
  readonly teardownListeners: Array<() => void>
  stopServer?: () => void
  closed: boolean
}

const parseConnectRequest = (value: unknown): Schema.Schema.Type<typeof RpcConnectionRequestSchema> | undefined => {
  try {
    return Schema.decodeUnknownSync(RpcConnectionRequestSchema)(value)
  } catch {
    return undefined
  }
}

const createRpcMessagePort = (native: MessagePortMain): RpcMessagePort => {
  let closed = false
  const closeListeners = new Set<() => void>()
  const onNativeClose = (): void => {
    if (closed) return
    closed = true
    for (const listener of [...closeListeners]) listener()
  }
  native.on('close', onNativeClose)

  return {
    send: frame =>
      Effect.try({
        try: () => {
          if (closed) throw new Error('closed')
          native.postMessage(frame)
        },
        catch: () => new RpcPortError({ code: closed ? 'closed' : 'send-failed' }),
      }),
    subscribe: receive =>
      Effect.sync(() => {
        const listener = (event: { readonly data: unknown }): void => receive(event.data)
        if (closed) return () => undefined
        native.on('message', listener)
        native.start()
        let active = true
        return () => {
          if (!active) return
          active = false
          native.removeListener('message', listener)
        }
      }),
    subscribeClose: onClose =>
      Effect.sync(() => {
        if (closed) {
          onClose()
          return () => undefined
        }
        closeListeners.add(onClose)
        let active = true
        return () => {
          if (!active) return
          active = false
          closeListeners.delete(onClose)
        }
      }),
    close: () =>
      Effect.sync(() => {
        if (closed) return
        onNativeClose()
        native.close()
      }),
  }
}

/** Registers the fixed, versioned MessagePort handshake on Electron's main IPC endpoint. */
export const registerElectronRpc = (options: RegisterElectronRpcOptions): (() => void) => {
  const channels = new Map<number, NativeConnection>()
  const generations = new WeakMap<WebContents, number>()
  let disposed = false

  const removeLifecycleListeners = (connection: NativeConnection): void => {
    for (const remove of connection.teardownListeners.splice(0)) remove()
  }

  const closeConnection = (connection: NativeConnection): void => {
    if (connection.closed) return
    connection.closed = true
    if (channels.get(connection.sender.id) === connection) channels.delete(connection.sender.id)
    removeLifecycleListeners(connection)
    try {
      connection.stopServer?.()
    } catch {
      // Connection cleanup is best effort after the peer has terminated.
    }
    try {
      connection.port.close()
    } catch {
      // Electron can throw when a renderer has already gone away.
    }
  }

  const refuse = (
    sender: WebContents,
    requestId: number | undefined,
    code: 'unavailable' | 'protocol' = 'unavailable',
  ): void => {
    if (requestId === undefined || sender.isDestroyed()) return
    try {
      sender.send(
        PORT_CHANNEL,
        Schema.decodeUnknownSync(RpcConnectionResponseSchema)({
          _tag: 'Rejected',
          version: PROTOCOL_VERSION,
          requestId,
          code,
        }),
      )
    } catch {
      // Do not include sender data or request payloads in errors.
    }
  }

  const onConnect = (event: IpcMainEvent, raw: unknown): void => {
    const request = parseConnectRequest(raw)
    if (disposed || !request) return
    const { sender, senderFrame } = event
    if (
      request.version !== PROTOCOL_VERSION ||
      sender.isDestroyed() ||
      !senderFrame ||
      senderFrame !== sender.mainFrame
    ) {
      refuse(sender, request.requestId, request.version === PROTOCOL_VERSION ? 'unavailable' : 'protocol')
      return
    }
    let role: RpcWindowRole | undefined
    try {
      role = options.resolveRole({ webContents: sender, frame: senderFrame, url: senderFrame.url })
    } catch {
      role = undefined
    }
    if (!role) {
      refuse(sender, request.requestId)
      return
    }

    const previous = channels.get(sender.id)
    if (previous) closeConnection(previous)
    const generation = (generations.get(sender) ?? 0) + 1
    generations.set(sender, generation)
    let channel: { readonly port1: MessagePortMain; readonly port2: MessagePortMain }
    try {
      channel = options.createChannel?.() ?? new MessageChannelMain()
    } catch {
      refuse(sender, request.requestId)
      return
    }
    const rpcPort = createRpcMessagePort(channel.port1)
    const connection: NativeConnection = {
      sender,
      generation,
      port: channel.port1,
      rpcPort,
      teardownListeners: [],
      closed: false,
    }
    channels.set(sender.id, connection)

    const onPortClose = (): void => closeConnection(connection)
    channel.port1.on('close', onPortClose)
    connection.teardownListeners.push(() => channel.port1.removeListener('close', onPortClose))
    const onDestroyed = (): void => closeConnection(connection)
    sender.once('destroyed', onDestroyed)
    connection.teardownListeners.push(() => sender.removeListener('destroyed', onDestroyed))
    const onGone = (): void => closeConnection(connection)
    sender.once('render-process-gone', onGone)
    connection.teardownListeners.push(() => sender.removeListener('render-process-gone', onGone))
    const onNavigation = (
      _electronEvent: Electron.Event,
      _url: string,
      _sameDocument: boolean,
      isMainFrame: boolean,
    ) => {
      if (isMainFrame) closeConnection(connection)
    }
    sender.on('did-start-navigation', onNavigation)
    connection.teardownListeners.push(() => sender.removeListener('did-start-navigation', onNavigation))

    try {
      connection.stopServer = options.onConnection(rpcPort, role, sender)
      sender.postMessage(
        PORT_CHANNEL,
        Schema.decodeUnknownSync(RpcConnectionResponseSchema)({
          _tag: 'Ready',
          version: PROTOCOL_VERSION,
          requestId: request.requestId,
          generation,
        }),
        [channel.port2],
      )
    } catch {
      closeConnection(connection)
      refuse(sender, request.requestId)
    }
  }

  options.ipcMain.on(CONNECT_CHANNEL, onConnect)

  return () => {
    if (disposed) return
    disposed = true
    options.ipcMain.removeListener(CONNECT_CHANNEL, onConnect)
    for (const connection of [...channels.values()]) closeConnection(connection)
  }
}
