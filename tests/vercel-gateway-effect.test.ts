import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as TestClock from 'effect/testing/TestClock'
import { afterEach, describe, expect, it } from 'vitest'

import { Env, resolveGatewayKey } from '../src/main/env.js'
import { HttpFetch, worstCaseRetryWindowMs } from '../src/main/pipeline/fetch-utils.js'
import { takeQueuedLogRecords } from '../src/main/pipeline/file-errors.js'
import {
  discoverVercelGatewaySessionsEffect,
  fetchVercelGatewayReportEffect,
  type ReportRow,
  vercelGateway,
} from '../src/main/pipeline/providers/vercel-gateway.js'
import type { DateRange } from '../src/main/pipeline/types.js'
import { runEffectTest } from './helpers/run-effect-test.js'

const RANGE: DateRange = {
  start: new Date('2026-01-01T00:00:00.000Z'),
  end: new Date('2026-01-31T00:00:00.000Z'),
}

afterEach(() => {
  takeQueuedLogRecords()
})

function runEffect(dateRange: DateRange, fetchImpl: typeof fetch, gatewayKey: string | null): Promise<ReportRow[]> {
  return Effect.runPromise(
    fetchVercelGatewayReportEffect(dateRange).pipe(
      Effect.provide(HttpFetch.layerWithFetch(fetchImpl)),
      Effect.provide(Env.layerWithGatewayKey(gatewayKey)),
    ),
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
  const countingFetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
    calls += 1
    return inner(...args)
  }) as typeof fetch
  return { fetch: countingFetch, getCalls: () => calls }
}

describe('fetchVercelGatewayReportEffect (Effect-native gateway boundary)', () => {
  it('no-key returns [] with zero fetch calls', async () => {
    const { fetch: counting, getCalls } = fakeCountingFetch({ results: [] })
    const rows = await runEffect(RANGE, counting, null)
    expect(rows).toEqual([])
    expect(getCalls()).toBe(0)
  })

  it('200 with results passes rows through', async () => {
    const results = [
      { day: '2026-01-05', model: 'openai/gpt-4o', total_cost: 1.5, input_tokens: 10, output_tokens: 20 },
      { day: '2026-01-06', model: 'anthropic/claude', total_cost: 0.5, input_tokens: 5, output_tokens: 5 },
    ]
    const okFetch = fakeJsonFetch(200, { results })
    await expect(runEffect(RANGE, okFetch, 'test-key')).resolves.toEqual(results)
    expect(loggedCodes()).toEqual([])
  })

  it('runs through the layerWithValues fake (live-vs-fake pair)', async () => {
    const results = [
      { day: '2026-01-05', model: 'openai/gpt-4o', total_cost: 1.5, input_tokens: 10, output_tokens: 20 },
    ]
    const rows = await Effect.runPromise(
      fetchVercelGatewayReportEffect(RANGE).pipe(
        Effect.provide(HttpFetch.layerWithFetch(fakeJsonFetch(200, { results }))),
        Effect.provide(
          Env.layerWithValues({
            vercelGatewayApiKey: 'test-key',
            pricingCacheTtlMs: Infinity,
          }),
        ),
      ),
    )
    expect(rows).toEqual(results)
    expect(loggedCodes()).toEqual([])
  })

  it('non-2xx returns [] and logs the status code', async () => {
    const badStatus = fakeJsonFetch(500, {})
    await expect(runEffect(RANGE, badStatus, 'test-key')).resolves.toEqual([])
    expect(loggedCodes()).toEqual(['http-500'])
  })

  it('network throw returns [] and logs unreachable', async () => {
    await expect(runEffect(RANGE, throwingFetch(), 'test-key')).resolves.toEqual([])
    expect(loggedCodes()).toEqual(['unreachable'])
  })

  it('timeout via TestClock returns []', async () => {
    const rows = await runEffectTest(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          fetchVercelGatewayReportEffect(RANGE).pipe(
            Effect.provide(HttpFetch.layerWithFetch(neverFetch())),
            Effect.provide(Env.layerWithGatewayKey('test-key')),
          ),
        )
        // Use the schedule-derived worst-case retry window so TestClock
        // reaches the request timeout before the test joins the fiber.
        yield* TestClock.adjust(yield* worstCaseRetryWindowMs(8_000))
        return yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(rows).toEqual([])
    expect(loggedCodes()).toEqual(['timeout'])
  })

  it('malformed body (no results) returns []', async () => {
    await expect(runEffect(RANGE, fakeJsonFetch(200, {}), 'test-key')).resolves.toEqual([])
    expect(loggedCodes()).toEqual([])
  })
})

describe('resolveGatewayKey (env trim/empty normalization)', () => {
  it('trims surrounding whitespace', () => {
    expect(resolveGatewayKey('  test-key  ', undefined)).toBe('test-key')
  })

  it('maps empty and whitespace-only to null', () => {
    expect(resolveGatewayKey('', undefined)).toBeNull()
    expect(resolveGatewayKey('   ', undefined)).toBeNull()
    expect(resolveGatewayKey(undefined, undefined)).toBeNull()
  })

  it('prefers the primary key and falls back to the secondary', () => {
    expect(resolveGatewayKey('primary', 'fallback')).toBe('primary')
    expect(resolveGatewayKey(undefined, 'fallback')).toBe('fallback')
    // Empty primary blocks the fallback (legacy `??` parity): never fall through.
    expect(resolveGatewayKey('', 'fallback')).toBeNull()
  })
})

describe('discoverVercelGatewaySessionsEffect (discovery through Env layer)', () => {
  async function runWithGuardedFetch<T>(run: () => Promise<T>): Promise<T> {
    const envBefore: NodeJS.ProcessEnv = { ...process.env }
    let fetchCalls = 0
    const originalFetch: typeof fetch = globalThis.fetch
    const countingFetch = (async (...args: Parameters<typeof globalThis.fetch>) => {
      fetchCalls += 1
      return fakeJsonFetch(200, { results: [] })(...args)
    }) as typeof fetch
    ;(globalThis as { fetch: typeof fetch }).fetch = countingFetch
    try {
      return await run()
    } finally {
      ;(globalThis as { fetch: typeof fetch }).fetch = originalFetch
      expect(fetchCalls).toBe(0)
      expect(process.env).toEqual(envBefore)
    }
  }

  it('no-key returns [] with zero fetch and zero process.env mutation', async () => {
    const rows = await runWithGuardedFetch(() =>
      Effect.runPromise(discoverVercelGatewaySessionsEffect().pipe(Effect.provide(Env.layerWithGatewayKey(null)))),
    )
    expect(rows).toEqual([])
  })

  it('keyed discovery returns the gateway source via fake Env layer', async () => {
    const rows = await Effect.runPromise(
      discoverVercelGatewaySessionsEffect().pipe(Effect.provide(Env.layerWithGatewayKey('test-key'))),
    )
    expect(rows).toEqual([
      { path: 'vercel-ai-gateway:report', project: 'Vercel AI Gateway', provider: 'vercel-gateway' },
    ])
  })

  it('Provider.discoverSessions keeps the Promise<SessionSource[]> interface', async () => {
    const sources = await runWithGuardedFetch(async () => {
      const pending = vercelGateway.discoverSessions()
      expect(pending).toBeInstanceOf(Promise)
      return pending
    })
    expect(Array.isArray(sources)).toBe(true)
    for (const source of sources) {
      expect(source.provider).toBe('vercel-gateway')
    }
  })
})
