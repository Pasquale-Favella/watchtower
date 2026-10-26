import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Layer from 'effect/Layer'
import { RpcServer } from 'effect/rpc'
import { describe, expect, it, vi } from 'vitest'

import { analyticsHandlers, configHandlers } from '../src/main/rpc/handlers.js'
import { RendererApi } from '../src/renderer/src/shared/lib/renderer-api.js'
import { rendererRpcApiLayer } from '../src/renderer/src/shared/lib/renderer-rpc-api.js'
import { ApplicationRpcGroup } from '../src/shared/rpc/application.js'
import type { RpcBridge } from '../src/shared/rpc/bridge.js'
import { type RpcMessagePort, serverProtocolLayer } from '../src/shared/rpc/port-protocol.js'
import { unexpectedNativeHandlers } from './fixtures/unexpected-native-rpc.js'

function transport() {
  const clientListeners = new Set<(frame: unknown) => void>()
  const serverListeners = new Set<(frame: unknown) => void>()
  const closed = new Set<() => void>()
  let disconnects = 0
  const subscribe = <A>(set: Set<(value: A) => void>, listener: (value: A) => void) => {
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }
  const bridge: RpcBridge = {
    connect: async () => ({ _tag: 'Connected', generation: 1 }),
    send: async frame => {
      for (const listener of serverListeners) listener(structuredClone(frame))
    },
    onMessage: listener => subscribe(clientListeners, listener),
    onClose: listener => subscribe(closed, listener),
    disconnect: () => {
      disconnects += 1
      for (const listener of closed) listener()
    },
  }
  const server: RpcMessagePort = {
    send: frame =>
      Effect.sync(() => {
        for (const listener of clientListeners) listener(structuredClone(frame))
      }),
    subscribe: listener => Effect.sync(() => subscribe(serverListeners, listener)),
    subscribeClose: listener => Effect.sync(() => subscribe(closed, listener)),
    close: () => Effect.void,
  }
  return {
    bridge,
    server,
    disconnects: () => disconnects,
    listeners: () => clientListeners.size + serverListeners.size + closed.size,
  }
}

describe('renderer RPC service', () => {
  it('uses generated contracts for reads and commands and closes its scoped transport', async () => {
    const ports = transport()
    const request = vi.fn(async (operation: string, ...args: unknown[]) => {
      if (operation === 'store:session') return null
      if (operation === 'store:sessions') return []
      if (operation === 'store:status') return { scanned: false }
      if (operation === 'settings:clear')
        return { dataDir: '/data', dbSize: 10, dataDirSize: 20, cacheDir: '/cache', cacheSize: 5 }
      if (operation === 'models:setPrice') return { ok: true }
      throw new Error(`private-path:${args}`)
    })
    const server = RpcServer.layer(ApplicationRpcGroup.omit('app:events'), { disableTracing: true }).pipe(
      Layer.provide(
        Layer.mergeAll(
          unexpectedNativeHandlers,
          serverProtocolLayer(ports.server),
          analyticsHandlers({ request }),
          configHandlers({ request }, Effect.succeed(0)),
        ),
      ),
    )
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const api = yield* RendererApi
          const rows = yield* api.getSessions({ project: 'test' })
          const session = yield* api.getSession('duplicate', 2)
          const status = yield* api.getScanStatus()
          const cleared = yield* api.clearData()
          yield* api.setModelPrice('model', 1, 2)
          const failure = yield* Effect.exit(api.getOverview({ period: 'week' }))
          return { rows, session, status, cleared, failure }
        }),
      ).pipe(Effect.provide(Layer.merge(rendererRpcApiLayer(ports.bridge), server))),
    )
    expect(result).toMatchObject({ rows: [], session: null, status: { scanned: false }, cleared: { dataDir: '/data' } })
    expect(Exit.isFailure(result.failure)).toBe(true)
    expect(String(result.failure)).not.toContain('private-path')
    expect(request.mock.calls).toEqual([
      ['store:sessions', { project: 'test' }],
      ['store:session', 'duplicate', 2],
      ['store:status'],
      ['settings:clear'],
      ['models:setPrice', 'model', 1, 2],
      ['overview:query', { period: 'week' }],
    ])
    expect(ports.disconnects()).toBe(1)
    expect(ports.listeners()).toBe(0)
  })

  it('reports connection failure through command errors without invoking a legacy application call', async () => {
    const ports = transport()
    const bridge: RpcBridge = { ...ports.bridge, connect: async () => ({ _tag: 'Failed', code: 'unavailable' }) }
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const api = yield* RendererApi
          return yield* Effect.exit(api.getScanStatus())
        }),
      ).pipe(Effect.provide(rendererRpcApiLayer(bridge))),
    )
    expect(Exit.isFailure(result)).toBe(true)
    expect(String(result)).toContain('Unable to reach the application.')
  })
})
