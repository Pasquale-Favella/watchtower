import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as RpcTest from 'effect/rpc/RpcTest'
import { describe, expect, it, vi } from 'vitest'

import { analyticsHandlers, configHandlers } from '../src/main/rpc/handlers.js'
import { ApplicationRpcGroup, PanelRpcGroup } from '../src/shared/rpc/application.js'

describe('main RPC worker forwarding', () => {
  it('retains source identity and the legacy positional argument representation', async () => {
    const request = vi.fn(() => Promise.resolve(null))
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ApplicationRpcGroup)
      yield* client['store:session']({ sessionId: 'same-id', sourceId: 42 })
      yield* client['store:session']({ sessionId: 'same-id' })
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(analyticsHandlers({ request }), configHandlers({ request }))))
    await Effect.runPromise(program)
    expect(request.mock.calls).toEqual([
      ['store:session', 'same-id', 42],
      ['store:session', 'same-id'],
    ])
  })

  it('refuses panel requests outside its fixed Scopes before touching the worker', async () => {
    const request = vi.fn(() => Promise.resolve(null))
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(PanelRpcGroup)
        return yield* Effect.exit(client['overview:query']({ scope: { period: 'lifetime' } }))
      }).pipe(Effect.scoped, Effect.provide(analyticsHandlers({ request }, 'panel'))),
    )
    expect(request).not.toHaveBeenCalled()
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect(Cause.findError(result.cause)).toMatchObject({ _tag: 'Success', success: { code: 'invalid-request' } })
    }
  })

  it('turns malformed worker data into a safe declared failure', async () => {
    const request = vi.fn(() => Promise.resolve({ privatePrompt: 'do not expose this' }))
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(ApplicationRpcGroup)
        return yield* Effect.exit(client['overview:query']({ scope: { period: 'today' } }))
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(analyticsHandlers({ request }), configHandlers({ request })))),
    )
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      expect(Cause.findError(result.cause)).toMatchObject({
        _tag: 'Success',
        success: { _tag: 'AnalyticsRpcError', message: 'Analytics query failed' },
      })
      expect(JSON.stringify(result)).not.toContain('privatePrompt')
    }
  })

  it('forwards each admitted configuration write exactly once', async () => {
    const request = vi.fn(() => Promise.resolve({ ok: true }))
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(ApplicationRpcGroup)
      yield* client['models:setPrice']({ model: 'model-a', inputPricePerMillion: 1, outputPricePerMillion: 2 })
      yield* client['models:setPrice']({ model: 'model-b', inputPricePerMillion: 3, outputPricePerMillion: 4 })
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(analyticsHandlers({ request }), configHandlers({ request }))))
    await Effect.runPromise(program)
    expect(request.mock.calls).toEqual([
      ['models:setPrice', 'model-a', 1, 2],
      ['models:setPrice', 'model-b', 3, 4],
    ])
  })
})
