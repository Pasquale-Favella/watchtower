import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as TestClock from 'effect/testing/TestClock'
import { afterEach, describe, expect, it } from 'vitest'

import { HttpFetch } from '../src/main/pipeline/fetch-utils.js'
import { takeQueuedLogRecords } from '../src/main/pipeline/file-errors.js'
import { fetchVercelGatewayReportEffect, type ReportRow } from '../src/main/pipeline/providers/vercel-gateway.js'
import type { DateRange } from '../src/main/pipeline/types.js'

const RANGE: DateRange = {
  start: new Date('2026-01-01T00:00:00.000Z'),
  end: new Date('2026-01-31T00:00:00.000Z'),
}

const SAVED_GATEWAY_KEY = process.env['AI_GATEWAY_API_KEY']
const SAVED_OIDC_TOKEN = process.env['VERCEL_OIDC_TOKEN']

function setKey(value: string | undefined): void {
  delete process.env['AI_GATEWAY_API_KEY']
  delete process.env['VERCEL_OIDC_TOKEN']
  if (value !== undefined) process.env['AI_GATEWAY_API_KEY'] = value
}

afterEach(() => {
  if (SAVED_GATEWAY_KEY === undefined) delete process.env['AI_GATEWAY_API_KEY']
  else process.env['AI_GATEWAY_API_KEY'] = SAVED_GATEWAY_KEY
  if (SAVED_OIDC_TOKEN === undefined) delete process.env['VERCEL_OIDC_TOKEN']
  else process.env['VERCEL_OIDC_TOKEN'] = SAVED_OIDC_TOKEN
  takeQueuedLogRecords()
})

function runEffect(dateRange: DateRange, fetchImpl: typeof fetch): Promise<ReportRow[]> {
  return Effect.runPromise(
    fetchVercelGatewayReportEffect(dateRange).pipe(Effect.provide(HttpFetch.layerWithFetch(fetchImpl))),
  )
}

function loggedCodes(): string[] {
  return takeQueuedLogRecords().map(record => record.fields.code)
}

function fakeJsonFetch(status: number, body: unknown): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch
}

function throwingFetch(): typeof fetch {
  return (async () => {
    throw new Error('offline')
  }) as unknown as typeof fetch
}

function neverFetch(): typeof fetch {
  return (() => new Promise<Response>(() => {})) as typeof fetch
}

function fakeCountingFetch(body: unknown): { fetch: typeof fetch; getCalls: () => number } {
  let calls = 0
  const inner = fakeJsonFetch(200, body)
  const fetch = (async (...args: Parameters<typeof fetch>) => {
    calls += 1
    return inner(...args)
  }) as typeof fetch
  return { fetch, getCalls: () => calls }
}

describe('fetchVercelGatewayReportEffect (Effect-native gateway boundary)', () => {
  it('no-key returns [] with zero fetch calls', async () => {
    setKey(undefined)
    const { fetch: counting, getCalls } = fakeCountingFetch({ results: [] })
    const rows = await runEffect(RANGE, counting)
    expect(rows).toEqual([])
    expect(getCalls()).toBe(0)
  })

  it('200 with results passes rows through', async () => {
    setKey('test-key')
    const results = [
      { day: '2026-01-05', model: 'openai/gpt-4o', total_cost: 1.5, input_tokens: 10, output_tokens: 20 },
      { day: '2026-01-06', model: 'anthropic/claude', total_cost: 0.5, input_tokens: 5, output_tokens: 5 },
    ]
    const okFetch = fakeJsonFetch(200, { results })
    await expect(runEffect(RANGE, okFetch)).resolves.toEqual(results)
    expect(loggedCodes()).toEqual([])
  })

  it('non-2xx returns [] and logs the status code', async () => {
    setKey('test-key')
    const badStatus = fakeJsonFetch(500, {})
    await expect(runEffect(RANGE, badStatus)).resolves.toEqual([])
    expect(loggedCodes()).toEqual(['http-500'])
  })

  it('network throw returns [] and logs unreachable', async () => {
    setKey('test-key')
    await expect(runEffect(RANGE, throwingFetch())).resolves.toEqual([])
    expect(loggedCodes()).toEqual(['unreachable'])
  })

  it('timeout via TestClock returns []', async () => {
    setKey('test-key')
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          fetchVercelGatewayReportEffect(RANGE).pipe(Effect.provide(HttpFetch.layerWithFetch(neverFetch()))),
        )
        yield* TestClock.adjust(9000)
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(rows).toEqual([])
    expect(loggedCodes()).toEqual(['timeout'])
  })

  it('malformed body (no results) returns []', async () => {
    setKey('test-key')
    await expect(runEffect(RANGE, fakeJsonFetch(200, {}))).resolves.toEqual([])
    expect(loggedCodes()).toEqual([])
  })
})
