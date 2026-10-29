import type { Page } from '@playwright/test'

import type { Api } from '../src/platform/electron/preload/index.js'

export type RpcProbeResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false }

/** Sends one uniquely identified request through the renderer's existing RPC bridge owner. */
export function invokeRpc(page: Page, tag: string, payload: unknown = null): Promise<RpcProbeResult> {
  return page.evaluate(
    async ({ tag, payload }) => {
      const bridge = (globalThis as typeof globalThis & { window: { api: Api } }).window.api.rpcV1
      const connection = await bridge.connect()
      if (connection._tag !== 'Connected') return { ok: false }

      const requestId = `e2e-probe-${crypto.randomUUID()}`
      return new Promise<RpcProbeResult>(resolve => {
        let settled = false
        let unsubscribeMessage = () => {}
        let unsubscribeClose = () => {}
        const timer = setTimeout(() => finish({ ok: false }), 10_000)
        const finish = (result: RpcProbeResult) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          unsubscribeMessage()
          unsubscribeClose()
          resolve(result)
        }

        unsubscribeMessage = bridge.onMessage(raw => {
          if (typeof raw !== 'string') return
          let frame: unknown
          try {
            frame = JSON.parse(raw)
          } catch {
            finish({ ok: false })
            return
          }
          if (!frame || typeof frame !== 'object') return
          const exit = frame as { _tag?: unknown; requestId?: unknown; exit?: unknown }
          if (exit._tag !== 'Exit' || exit.requestId !== requestId || !exit.exit || typeof exit.exit !== 'object')
            return
          const result = exit.exit as { _tag?: unknown; value?: unknown }
          if (result._tag === 'Success') finish({ ok: true, value: result.value })
          else if (result._tag === 'Failure') finish({ ok: false })
        }, connection.generation)
        unsubscribeClose = bridge.onClose(() => finish({ ok: false }), connection.generation)

        void bridge
          .send(JSON.stringify({ _tag: 'Request', id: requestId, tag, payload, headers: [] }), connection.generation)
          .catch(() => finish({ ok: false }))
      })
    },
    { tag, payload },
  )
}
