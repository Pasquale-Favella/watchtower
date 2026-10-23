import { Effect } from 'effect'
import { RpcGroup, RpcTest } from 'effect/rpc'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import { GetSession } from '../src/shared/rpc/analytics.js'
import { AnalyticsRpcError } from '../src/shared/rpc/errors.js'

const SessionRpcGroup = RpcGroup.make(GetSession)

describe('renderer RPC contracts', () => {
  it('passes source identity through RpcTest and returns the declared nullable result', async () => {
    let received: { sessionId: string; sourceId?: number } | undefined
    const handlers = SessionRpcGroup.toLayer(
      SessionRpcGroup.of({
        'store:session': payload =>
          Effect.sync(() => {
            received = payload
            return null
          }),
      }),
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(SessionRpcGroup)
          return yield* client['store:session']({ sessionId: 'session-1', sourceId: 42 })
        }),
      ).pipe(Effect.provide(handlers)),
    )

    expect(received).toEqual({ sessionId: 'session-1', sourceId: 42 })
    expect(result).toBeNull()
  })

  it('encodes and decodes the request and nullable success using the RPC schemas', () => {
    const request = { sessionId: 'session-1', sourceId: 42 }
    const encodedRequest = Schema.encodeUnknownSync(GetSession.payloadSchema)(request)
    expect(encodedRequest).toEqual(request)
    expect(Schema.decodeUnknownSync(GetSession.payloadSchema)(encodedRequest)).toEqual(request)

    const encodedResult = Schema.encodeUnknownSync(GetSession.successSchema)(null)
    expect(encodedResult).toBeNull()
    expect(Schema.decodeUnknownSync(GetSession.successSchema)(encodedResult)).toBeNull()
  })

  it('serializes only the safe tagged error fields', () => {
    const error = new AnalyticsRpcError({ code: 'query-failed', message: 'Analytics query failed' })
    const encoded = Schema.encodeUnknownSync(AnalyticsRpcError)(error)

    expect(encoded).toMatchObject({
      _tag: 'AnalyticsRpcError',
      code: 'query-failed',
      message: 'Analytics query failed',
    })
    expect(encoded).not.toHaveProperty('stack')
    expect(encoded).not.toHaveProperty('cause')
  })
})
