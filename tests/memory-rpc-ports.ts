import * as Effect from 'effect/Effect'

import type { RpcMessagePort } from '../src/shared/rpc/port-protocol.js'

interface PortState {
  closed: boolean
  readonly receivers: Set<(frame: unknown) => void>
  readonly closeListeners: Set<() => void>
  removals: number
  closeCalls: number
  readonly sent: string[]
}

/** In-memory MessagePort pair for exercising the production RPC serialization protocol. */
export const makeMemoryRpcPorts = (): readonly [RpcMessagePort, RpcMessagePort, readonly [PortState, PortState]] => {
  const createState = (): PortState => ({
    closed: false,
    receivers: new Set(),
    closeListeners: new Set(),
    removals: 0,
    closeCalls: 0,
    sent: [],
  })
  const left = createState()
  const right = createState()
  const close = (state: PortState): void => {
    if (state.closed) return
    state.closed = true
    for (const listener of [...state.closeListeners]) listener()
  }
  const makePort = (local: PortState, remote: PortState): RpcMessagePort => ({
    send: frame =>
      Effect.suspend(() => {
        if (local.closed || remote.closed) return Effect.die(new Error('Memory RPC port closed'))
        local.sent.push(frame)
        for (const receiver of [...remote.receivers]) receiver(structuredClone(frame))
        return Effect.void
      }),
    subscribe: receive =>
      Effect.sync(() => {
        local.receivers.add(receive)
        let active = true
        return () => {
          if (!active) return
          active = false
          local.removals++
          local.receivers.delete(receive)
        }
      }),
    subscribeClose: listener =>
      Effect.sync(() => {
        if (local.closed) listener()
        else local.closeListeners.add(listener)
        let active = true
        return () => {
          if (!active) return
          active = false
          local.removals++
          local.closeListeners.delete(listener)
        }
      }),
    close: () =>
      Effect.sync(() => {
        local.closeCalls++
        close(local)
        close(remote)
      }),
  })
  return [makePort(left, right), makePort(right, left), [left, right]]
}
