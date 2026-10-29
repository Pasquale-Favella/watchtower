import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'

import { createRpcQuerySlot } from '../src/renderer/src/app/atoms/rpc-query.js'
import { createApplicationAtomRpc } from '../src/renderer/src/shared/lib/atom-rpc.js'
import type { RpcBridge } from '../src/shared/rpc/bridge.js'
import { reconnectingRendererProtocolLayer, RendererConnection } from '../src/shared/rpc/reconnecting-protocol.js'
import type { OverviewPeriod } from '../src/shared/schemas/overview.js'

describe('application RPC ownership', () => {
  it('shares one protocol acquisition across native AtomRpc and connection state, then disposes it', async () => {
    let connections = 0
    let sends = 0
    let disconnects = 0
    let listeners = 0
    const subscribe = () => {
      listeners += 1
      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        listeners -= 1
      }
    }
    const bridge: RpcBridge = {
      connect: async () => ({ _tag: 'Connected', generation: ++connections }),
      send: async () => {
        sends += 1
      },
      onMessage: () => subscribe(),
      onClose: () => subscribe(),
      disconnect: () => {
        disconnects += 1
      },
    }

    const registry = AtomRegistry.make()
    const rootFactory = Atom.context()
    const protocol = reconnectingRendererProtocolLayer(bridge, { initialRetryDelayMs: 10 })
    const client = createApplicationAtomRpc(rootFactory, protocol)
    const query = createRpcQuerySlot<OverviewPeriod, unknown, unknown>({
      key: value => value,
      query: (period, selectionId) =>
        client.query('overview:query', { scope: { period } }, { serializationKey: selectionId }),
    })
    const readinessFactory = rootFactory(get => Layer.merge(get(client.runtime.layer), protocol))
    const readConnection = readinessFactory.fn(() =>
      Effect.flatMap(RendererConnection, service =>
        service.changes.pipe(
          Stream.filter(state => state._tag === 'Connected'),
          Stream.runHead,
        ),
      ),
    )

    const unpinQuery = query.pin(registry)
    const unmountConnection = registry.mount(readConnection)
    try {
      registry.set(readConnection, undefined)
      await waitFor(() => {
        const result = registry.get(readConnection)
        expect(AsyncResult.isSuccess(result)).toBe(true)
        if (AsyncResult.isSuccess(result)) expect(Option.getOrThrow(result.value)._tag).toBe('Connected')
      })
      expect(connections).toBe(1)

      registry.set(query.requestAtom, 'today')
      await waitFor(() => expect(sends).toBeGreaterThan(0))
      expect(connections).toBe(1)
      expect(listeners).toBeGreaterThan(0)
    } finally {
      unpinQuery()
      unmountConnection()
      registry.dispose()
    }
    await waitFor(() => {
      expect(disconnects).toBe(1)
      expect(listeners).toBe(0)
    })
  })
})

const waitFor = async (assertion: () => void): Promise<void> => {
  const deadline = Date.now() + 1000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      lastError = error
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  throw lastError
}
