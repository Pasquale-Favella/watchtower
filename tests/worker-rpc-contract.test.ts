import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

import {
  SequencedWorkerEventSchema,
  WorkerEventSchema,
  WorkerRpcError,
  WorkerRpcGroup,
  workerSuccessSchema,
} from '../src/shared/rpc/worker.js'

const requiredOperations = [
  'store:views',
  'store:projects',
  'store:sessions',
  'store:session',
  'store:analytics',
  'overview:query',
  'sessions:view',
  'pullRequests:view',
  'spend:view',
  'models:view',
  'compare:view',
  'optimize:view',
  'optimize:yield',
  'skills:view',
  'store:search',
  'export:csv',
  'export:json',
  'skills:dismiss',
  'models:addAlias',
  'models:getAliases',
  'models:removeAlias',
  'models:getPriceOverrides',
  'models:removePriceOverride',
  'models:setPrice',
  'ledger-mcp:startup:get',
  'ledger-mcp:startup:set',
  'scan:start',
  'scan:active',
  'scan:abort',
  'worker:shutdown',
  'cadence:get',
  'cadence:set',
  'store:status',
  'settings:info',
  'settings:clear',
  'pricing:refresh',
  'currency:get',
  'currency:set',
  'currency:list',
]

const expectRoundTrip = <A, I>(schema: Schema.Codec<A, I>, value: A): void => {
  const encoded = Schema.encodeSync(schema)(value)
  expect(Schema.decodeUnknownSync(schema)(encoded)).toEqual(value)
}

describe('typed db-worker RPC contract', () => {
  it('covers each current query, config, export, lifecycle and maintenance operation', () => {
    for (const tag of requiredOperations) expect(WorkerRpcGroup.requests.has(tag)).toBe(true)
    expect(WorkerRpcGroup.requests.has('worker:ready')).toBe(true)
    expect(WorkerRpcGroup.requests.has('worker:events')).toBe(true)
  })

  it('preserves omitted optional session source identity and rejects invalid source ids', () => {
    const request = WorkerRpcGroup.requests.get('store:session')
    if (!request) throw new Error('store:session RPC is missing')

    expect(Schema.decodeUnknownSync(request.payloadSchema)({ sessionId: 'session-1' })).toEqual({
      sessionId: 'session-1',
    })
    expect(Schema.decodeUnknownResult(request.payloadSchema)({ sessionId: 'session-1', sourceId: 0 })._tag).toBe(
      'Failure',
    )
  })

  it('round-trips sequenced typed events and rejects unknown or malformed event payloads', () => {
    const event = {
      sequence: 4,
      event: {
        event: 'scan:progress',
        manual: true,
        progress: { stage: 'parse', provider: 'claude', processed: 3, total: 8 },
      },
    } as const
    expectRoundTrip(SequencedWorkerEventSchema, event)

    expect(Schema.decodeUnknownResult(WorkerEventSchema)({ event: 'unknown:event', content: 'not allowed' })._tag).toBe(
      'Failure',
    )
    expect(
      Schema.decodeUnknownResult(WorkerEventSchema)({
        event: 'scan:progress',
        manual: true,
        progress: { stage: 'unknown-stage' },
      })._tag,
    ).toBe('Failure')
  })

  it('requires a non-negative event watermark on every unary success envelope', () => {
    const success = workerSuccessSchema(Schema.Null)
    expectRoundTrip(success, { value: null, eventSequence: 0 })
    expect(Schema.decodeUnknownResult(success)({ value: null, eventSequence: -1 })._tag).toBe('Failure')
  })

  it('round-trips every safe worker error category through schema encoding', () => {
    const codes = [
      'not-ready',
      'invalid-request',
      'unavailable',
      'query-failed',
      'command-failed',
      'conflict',
      'cancelled',
      'initialization-failed',
      'shutting-down',
      'unsupported-schema-version',
      'invalid-stored-data',
      'database-unavailable',
      'database-access-denied',
      'database-query-invalid',
      'database-operation-failed',
      'event-overflow',
    ] as const

    for (const code of codes) {
      const failure = new WorkerRpcError({ code, message: 'The database worker operation failed.' })
      const encoded = Schema.encodeSync(WorkerRpcError)(failure)
      const decoded = Schema.decodeUnknownSync(WorkerRpcError)(encoded)
      expect(decoded).toMatchObject({
        _tag: 'WorkerRpcError',
        code,
        message: 'The database worker operation failed.',
      })
    }

    expect(
      Schema.decodeUnknownResult(WorkerRpcError)({
        _tag: 'WorkerRpcError',
        code: 'query-failed',
        message: 'a path or SQL detail must not be accepted',
      })._tag,
    ).toBe('Failure')
  })

  it('carries an optional non-negative event watermark on operation errors', () => {
    const failure = new WorkerRpcError({
      code: 'invalid-stored-data',
      message: 'The database worker operation failed.',
      eventSequence: 7,
    })
    expectRoundTrip(WorkerRpcError, failure)
    expect(
      Schema.decodeUnknownResult(WorkerRpcError)({
        _tag: 'WorkerRpcError',
        code: 'query-failed',
        message: 'The database worker operation failed.',
        eventSequence: -1,
      })._tag,
    ).toBe('Failure')
  })
})
