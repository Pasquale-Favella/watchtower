import type { RpcBridge } from '../src/shared/rpc/bridge.js'
import type { ShellEvent } from '../src/shared/rpc/shell.js'

/** Wire frames enter the production renderer protocol and Schema decoder. */
export function makeShellBridge(unavailable = false) {
  const listeners = new Set<(frame: unknown) => void>()
  const closes = new Set<() => void>()
  let requestId: string | undefined
  let requests = 0
  let interrupts = 0
  const emit = (event: ShellEvent): void => {
    for (const receive of listeners) receive(JSON.stringify({ _tag: 'Chunk', requestId, values: [event] }))
  }
  const bridge: RpcBridge = {
    connect: async () => (unavailable ? { _tag: 'Failed', code: 'unavailable' } : { _tag: 'Connected', generation: 1 }),
    send: async raw => {
      const frame = JSON.parse(raw)
      if (frame._tag === 'Request' && frame.tag === 'shell:events') {
        requestId = frame.id
        requests++
        queueMicrotask(() => emit({ _tag: 'Ready', placement: null }))
      } else if (frame._tag === 'Interrupt') interrupts++
    },
    onMessage: receive => {
      listeners.add(receive)
      return () => {
        listeners.delete(receive)
      }
    },
    onClose: close => {
      closes.add(close)
      return () => {
        closes.delete(close)
      }
    },
    disconnect: () => {
      for (const close of [...closes]) close()
    },
  }
  return { bridge, emit, counts: () => ({ requests, interrupts, listeners: listeners.size }) }
}
