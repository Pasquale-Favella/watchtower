import * as Cause from 'effect/Cause'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as RpcTest from 'effect/rpc/RpcTest'
import { describe, expect, it, vi } from 'vitest'

import { analyticsHandlers, configHandlers } from '../src/platform/electron/main/rpc/handlers.js'
import { AnalyticsRpcGroup } from '../src/shared/rpc/analytics.js'
import { PanelRpcGroup } from '../src/shared/rpc/application.js'
import { ConfigRpcGroup } from '../src/shared/rpc/config.js'

const DataRpcGroup = AnalyticsRpcGroup.merge(ConfigRpcGroup)

describe('main RPC worker forwarding', () => {
  it('retains source identity and the legacy positional argument representation', async () => {
    const request = vi.fn(() => Promise.resolve(null))
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(DataRpcGroup)
      yield* client['store:session']({ sessionId: 'same-id', sourceId: 42 })
      yield* client['store:session']({ sessionId: 'same-id' })
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(analyticsHandlers({ request }), configHandlers({ request }, Effect.succeed(0)))),
    )
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
        const client = yield* RpcTest.makeClient(
          PanelRpcGroup.omit(
            'panel:events',
            'scan:start',
            'shell:events',
            'shell:notice',
            'orb:placement',
            'orb:command',
          ),
        )
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
        const client = yield* RpcTest.makeClient(DataRpcGroup)
        return yield* Effect.exit(client['overview:query']({ scope: { period: 'today' } }))
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.merge(analyticsHandlers({ request }), configHandlers({ request }, Effect.succeed(0)))),
      ),
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
      const client = yield* RpcTest.makeClient(DataRpcGroup)
      yield* client['models:setPrice']({ model: 'model-a', inputPricePerMillion: 1, outputPricePerMillion: 2 })
      yield* client['models:setPrice']({ model: 'model-b', inputPricePerMillion: 3, outputPricePerMillion: 4 })
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.merge(analyticsHandlers({ request }), configHandlers({ request }, Effect.succeed(0)))),
    )
    await Effect.runPromise(program)
    expect(request.mock.calls).toEqual([
      ['models:setPrice', 'model-a', 1, 2],
      ['models:setPrice', 'model-b', 3, 4],
    ])
  })

  it('receipts include the committing write even when another window changes config first', async () => {
    const entered = await Effect.runPromise(Deferred.make<undefined>())
    const commit = await Effect.runPromise(Deferred.make<undefined>())
    let revision = 0
    let settled = false
    const request = vi.fn(() =>
      Effect.runPromise(
        Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(commit)).pipe(Effect.as({ ok: true })),
      ),
    )
    const receipt = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* RpcTest.makeClient(DataRpcGroup)
        const write = yield* Effect.forkChild(
          client['models:setPrice']({ model: 'mine', inputPricePerMillion: 1, outputPricePerMillion: 2 }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                settled = true
              }),
            ),
          ),
        )
        yield* Deferred.await(entered)
        revision = 1
        yield* Effect.yieldNow
        expect(settled).toBe(false)
        // The worker posts our ConfigChanged before the write acknowledgement.
        revision = 2
        yield* Deferred.succeed(commit, undefined)
        return yield* Fiber.join(write)
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.merge(
            analyticsHandlers({ request }),
            configHandlers(
              { request },
              Effect.sync(() => revision),
            ),
          ),
        ),
      ),
    )
    expect(receipt).toEqual({ ok: true, configRevision: 2 })
    expect(request).toHaveBeenCalledTimes(1)
  })
})
