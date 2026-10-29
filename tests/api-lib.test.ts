import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as Schema from 'effect/Schema'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { configHandlers } from '../src/platform/electron/main/rpc/handlers.js'
import { ConfigRpcGroup } from '../src/shared/rpc/config.js'

describe('generated config RPC contracts', () => {
  it('preserves arbitrary cadence strings, validates FX payloads, and hides malformed worker data', async () => {
    let invalidCurrency = false
    const request = vi.fn(async (operation: string, ...args: unknown[]) => {
      if (operation === 'cadence:get') return 'custom-cadence'
      if (operation === 'cadence:set') return args[0]
      if (operation === 'currency:get') return { code: 'EUR', symbol: '€', rate: invalidCurrency ? Number.NaN : 0.9 }
      throw new Error('private worker detail')
    })
    const handlers = configHandlers({ request }, Effect.succeed(0))
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(ConfigRpcGroup)
        const cadence = yield* client['cadence:get']()
        const setCadence = yield* client['cadence:set']({ value: 'manual-custom' })
        const currency = yield* client['currency:get']()
        const invalidRequest = yield* Effect.exit(client['cadence:set']({ value: 4 } as never))
        invalidCurrency = true
        const invalidResponse = yield* Effect.exit(client['currency:get']())
        return { cadence, setCadence, currency, invalidRequest, invalidResponse }
      }).pipe(Effect.scoped, Effect.provide(handlers)),
    )

    expect(result.cadence).toBe('custom-cadence')
    expect(result.setCadence).toBe('manual-custom')
    expect(result.currency).toEqual({ code: 'EUR', symbol: '€', rate: 0.9 })
    expect(Exit.isFailure(result.invalidRequest)).toBe(true)
    expect(Exit.isFailure(result.invalidResponse)).toBe(true)
    expect(JSON.stringify(result.invalidResponse)).not.toContain('private worker detail')
    expect(request.mock.calls).toEqual([
      ['cadence:get'],
      ['cadence:set', 'manual-custom'],
      ['currency:get'],
      ['currency:get'],
    ])
  })
})
