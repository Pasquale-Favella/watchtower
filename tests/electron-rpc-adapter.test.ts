import { EventEmitter } from 'node:events'

import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { registerElectronRpc, type RpcWindowRole } from '../src/main/rpc/electron.js'
import { createRpcBridge } from '../src/preload/rpc.js'
import type { RpcMessagePort } from '../src/shared/rpc/port-protocol.js'

const CONNECT = 'rpc:v1:connect'
const PORT = 'rpc:v1:port'

class FakeMessagePort extends EventEmitter {
  peer?: FakeMessagePort
  closed = false

  postMessage(message: unknown): void {
    if (this.closed) throw new Error('closed')
    this.peer?.emit('message', { data: structuredClone(message) })
  }

  start(): void {}

  addEventListener(type: 'message' | 'close' | 'messageerror', listener: (event: { data?: unknown }) => void): void {
    this.on(type, listener)
  }

  removeEventListener(type: 'message' | 'close' | 'messageerror', listener: (event: { data?: unknown }) => void): void {
    this.removeListener(type, listener)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.emit('close')
    if (this.peer && !this.peer.closed) {
      this.peer.closed = true
      this.peer.emit('close')
    }
  }
}

const createChannel = (): { readonly port1: FakeMessagePort; readonly port2: FakeMessagePort } => {
  const port1 = new FakeMessagePort()
  const port2 = new FakeMessagePort()
  port1.peer = port2
  port2.peer = port1
  return { port1, port2 }
}

class FakeIpcRenderer {
  readonly listeners = new Map<string, Set<(event: { ports?: readonly FakeMessagePort[] }, data: unknown) => void>>()
  readonly requests: Array<{ channel: string; request: unknown }> = []
  onConnect?: (event: FakeIpcEvent, request: unknown) => void
  event?: FakeIpcEvent

  on(channel: string, listener: (event: { ports?: readonly FakeMessagePort[] }, data: unknown) => void): void {
    const listeners = this.listeners.get(channel) ?? new Set()
    listeners.add(listener)
    this.listeners.set(channel, listeners)
  }

  removeListener(
    channel: string,
    listener: (event: { ports?: readonly FakeMessagePort[] }, data: unknown) => void,
  ): void {
    this.listeners.get(channel)?.delete(listener)
  }

  send(channel: string, request: unknown): void {
    this.requests.push({ channel, request })
    this.onConnect?.(this.event as FakeIpcEvent, request)
  }

  deliver(channel: string, data: unknown, ports?: readonly FakeMessagePort[]): void {
    const event = { ports }
    for (const listener of [...(this.listeners.get(channel) ?? [])]) listener(event, data)
  }
}

class FakeWebContents extends EventEmitter {
  readonly id = 11
  readonly mainFrame = { url: 'file:///app/index.html' }
  destroyed = false
  ipc?: FakeIpcRenderer

  isDestroyed(): boolean {
    return this.destroyed
  }

  send(channel: string, data: unknown): void {
    this.ipc?.deliver(channel, data)
  }

  postMessage(channel: string, data: unknown, ports: FakeMessagePort[]): void {
    queueMicrotask(() => this.ipc?.deliver(channel, data, ports))
  }
}

interface FakeIpcEvent {
  readonly sender: FakeWebContents
  readonly senderFrame: FakeWebContents['mainFrame'] | { readonly url: string }
}

const createMain = (ipc: FakeIpcRenderer) => {
  const sender = new FakeWebContents()
  sender.ipc = ipc
  ipc.event = { sender, senderFrame: sender.mainFrame }
  const ipcMain = {
    on: (channel: string, listener: (event: FakeIpcEvent, request: unknown) => void) => {
      if (channel === CONNECT) ipc.onConnect = listener
    },
    removeListener: (channel: string) => {
      if (channel === CONNECT) ipc.onConnect = undefined
    },
  }
  return { sender, ipcMain }
}

const setup = (resolveRole: (url: string) => RpcWindowRole | undefined = () => 'app') => {
  const ipc = new FakeIpcRenderer()
  const { bridge, dispose } = createRpcBridge(ipc as never)
  const { sender, ipcMain } = createMain(ipc)
  const connections: Array<{ port: RpcMessagePort; role: RpcWindowRole; sender: FakeWebContents }> = []
  const teardowns: number[] = []
  let generation = 0
  const unregister = registerElectronRpc({
    ipcMain: ipcMain as never,
    resolveRole: context => resolveRole(context.url),
    createChannel: () => {
      generation++
      return createChannel() as never
    },
    onConnection: (port, role, webContents) => {
      connections.push({ port, role, sender: webContents as never })
      return () => teardowns.push(generation)
    },
  })
  return { ipc, bridge, dispose, sender, connections, teardowns, unregister }
}

describe('Electron RPC adapters', () => {
  it('connects through fixed channels and exposes only the narrow bridge capability', async () => {
    const { ipc, bridge, connections } = setup()
    const frames: unknown[] = []
    bridge.onMessage(frame => frames.push(frame), 1)
    const connection = await bridge.connect()

    expect(connection).toEqual({ _tag: 'Connected', generation: 1 })
    expect(ipc.requests).toEqual([{ channel: CONNECT, request: { version: 1, requestId: 1 } }])
    expect(connections).toHaveLength(1)
    expect(connections[0]?.role).toBe('app')
    expect(Object.keys(bridge).sort()).toEqual(['connect', 'disconnect', 'onClose', 'onMessage', 'send'])

    await bridge.send('{"_tag":"Ping"}', 1)
    await Effect.runPromise(connections[0]!.port.send('{"_tag":"Pong"}'))
    expect(frames).toEqual(['{"_tag":"Pong"}'])
    bridge.disconnect(1)
  })

  it('refuses an unknown document and a subframe without creating a port', async () => {
    const unknown = setup(() => undefined)
    expect(await unknown.bridge.connect()).toEqual({ _tag: 'Failed', code: 'unavailable' })
    expect(unknown.connections).toHaveLength(0)
    unknown.unregister()

    const subframe = setup()
    subframe.ipc.event = { sender: subframe.sender, senderFrame: { url: 'file:///app/iframe.html' } }
    expect(await subframe.bridge.connect()).toEqual({ _tag: 'Failed', code: 'unavailable' })
    expect(subframe.connections).toHaveLength(0)
    subframe.unregister()
  })

  it('rejects pending connection readiness on local disposal', async () => {
    const ipc = new FakeIpcRenderer()
    const { bridge, dispose } = createRpcBridge(ipc as never)
    const pending = bridge.connect()
    dispose()
    await expect(pending).resolves.toEqual({ _tag: 'Failed', code: 'closed' })
    const latePort = new FakeMessagePort()
    ipc.deliver(PORT, { _tag: 'Ready', version: 1, requestId: 1, generation: 1 }, [latePort])
    expect(latePort.closed).toBe(true)
    expect(ipc.listeners.get(PORT)?.size).toBe(0)
  })

  it('fails readiness when main never returns a port', async () => {
    const ipc = new FakeIpcRenderer()
    const { bridge, dispose } = createRpcBridge(ipc as never, 2)
    expect(await bridge.connect()).toEqual({ _tag: 'Failed', code: 'unavailable' })
    dispose()
  })

  it('closes old generations on navigation and reconnects with a new generation', async () => {
    const { bridge, sender, connections, teardowns } = setup()
    expect(await bridge.connect()).toEqual({ _tag: 'Connected', generation: 1 })
    const firstPort = connections[0]!.port
    let closed = false
    bridge.onClose(() => (closed = true), 1)
    sender.emit('did-start-navigation', {}, 'file:///app/index.html', false, true)
    expect(teardowns).toHaveLength(1)
    // Main-initiated navigation closes the transferred endpoint and notifies preload.
    expect(closed).toBe(true)
    expect(await bridge.connect()).toEqual({ _tag: 'Connected', generation: 2 })
    expect(connections).toHaveLength(2)
    expect(teardowns).toHaveLength(1)
    await expect(Effect.runPromise(firstPort.send('stale'))).rejects.toMatchObject({ code: 'closed' })
    bridge.disconnect(2)
  })

  it('closes all ports and scoped handlers when the adapter unregisters', async () => {
    const { bridge, unregister, connections, teardowns } = setup()
    await bridge.connect()
    unregister()
    unregister()
    expect(teardowns).toHaveLength(1)
    expect(connections[0]?.sender.listenerCount('did-start-navigation')).toBe(0)
    expect(connections[0]?.sender.listenerCount('destroyed')).toBe(0)
    expect(connections[0]?.sender.listenerCount('render-process-gone')).toBe(0)
    await expect(bridge.send('late', 1)).rejects.toBeInstanceOf(Error)
  })

  it('rejects unsupported protocol versions through the fixed response channel', async () => {
    const { bridge, ipc, unregister } = setup()
    const pending = bridge.connect()
    const requestId = (ipc.requests[0]?.request as { requestId: number }).requestId
    ipc.onConnect?.(ipc.event as FakeIpcEvent, { version: 2, requestId })
    await expect(pending).resolves.toEqual({ _tag: 'Failed', code: 'protocol' })
    unregister()
  })

  it('reconnects after scoped close and isolates new ports from stale listeners and cleanup', async () => {
    const { bridge, connections, dispose } = setup()
    await bridge.connect()
    const staleFrames: unknown[] = []
    bridge.onMessage(frame => staleFrames.push(frame), 1)
    bridge.disconnect(1)
    expect(await bridge.connect()).toEqual({ _tag: 'Connected', generation: 2 })
    bridge.disconnect(1)
    await expect(bridge.send('stale request', 1)).rejects.toBeInstanceOf(Error)
    await expect(bridge.send('{"_tag":"Ping"}', 2)).resolves.toBeUndefined()
    const currentFrames: unknown[] = []
    bridge.onMessage(frame => currentFrames.push(frame), 2)
    await Effect.runPromise(connections[1]!.port.send('{"_tag":"Pong"}'))
    expect(staleFrames).toEqual([])
    expect(currentFrames).toEqual(['{"_tag":"Pong"}'])
    dispose()
    expect(await bridge.connect()).toEqual({ _tag: 'Failed', code: 'closed' })
  })
})
