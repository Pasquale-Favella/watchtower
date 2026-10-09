import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { Env, resolveGatewayKey } from '../src/main/env.js'
import { HttpFetch, worstCaseRetryWindowMs } from '../src/main/pipeline/fetch-utils.js'
import { takeQueuedLogRecords } from '../src/main/pipeline/file-errors.js'
import type { SessionParser } from '../src/main/pipeline/providers/types.js'
import {
  discoverVercelGatewaySessionsEffect,
  fetchVercelGatewayReportEffect,
  type ReportRow,
  vercelGateway,
} from '../src/main/pipeline/providers/vercel-gateway.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import type { DateRange } from '../src/main/pipeline/types.js'
import { deferred } from './helpers/deferred.js'
import { runEffectTest, runWithTestClockWindow } from './helpers/run-effect-test.js'

const RANGE: DateRange = {
  start: new Date('2026-01-01T00:00:00.000Z'),
  end: new Date('2026-01-31T00:00:00.000Z'),
}

// The default ConfigProvider captures the environment at its first read.
beforeAll(() => vi.stubEnv('AI_GATEWAY_API_KEY', 'standalone-key'))
afterAll(() => vi.unstubAllEnvs())

afterEach(() => {
  takeQueuedLogRecords()
  vi.unstubAllGlobals()
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

function gatewayStream(parser: SessionParser): ReturnType<NonNullable<SessionParser['parseStream']>> {
  if (!parser.parseStream) throw new Error('Expected the native Gateway parser stream')
  return parser.parseStream()
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

  it('decodes nullable report fields and rejects malformed usage without logging the payload', async () => {
    const valid = [{ day: null, model: null, input_tokens: null, total_cost: 2 }]
    await expect(runEffect(RANGE, fakeJsonFetch(200, { results: valid }), 'test-key')).resolves.toEqual(valid)
    expect(loggedCodes()).toEqual([])
    await expect(
      runEffect(RANGE, fakeJsonFetch(200, { results: [{ input_tokens: 'private-invalid-usage' }] }), 'test-key'),
    ).resolves.toEqual([])
    expect(takeQueuedLogRecords()).toEqual([
      {
        logEvent: 'scan.file-error',
        level: 'warn',
        fields: { op: 'scan', provider: 'vercel-gateway', code: 'schema' },
      },
    ])
  })

  it('timeout via TestClock returns []', async () => {
    const rows = await runEffectTest(
      Effect.gen(function* () {
        return yield* runWithTestClockWindow(
          fetchVercelGatewayReportEffect(RANGE).pipe(
            Effect.provide(HttpFetch.layerWithFetch(neverFetch())),
            Effect.provide(Env.layerWithGatewayKey('test-key')),
          ),
          yield* worstCaseRetryWindowMs(8_000),
        )
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

describe('Vercel Gateway native parser stream', () => {
  it('keeps the standalone Promise parser fallback on its environment and fetch boundary', async () => {
    const rows = [{ day: '2026-01-05', model: 'openai/gpt-4o', total_cost: 1.5 }]
    const { fetch: fetcher, getCalls } = fakeCountingFetch({ results: rows })
    vi.stubGlobal('fetch', fetcher)
    await expect(Effect.runPromise(Env.pipe(Effect.provide(Env.layer)))).resolves.toMatchObject({
      vercelGatewayApiKey: 'standalone-key',
    })
    const parser = vercelGateway.createSessionParser(
      { path: 'vercel-ai-gateway:report', project: 'Vercel AI Gateway', provider: 'vercel-gateway' },
      new Set(),
      RANGE,
    )
    const parsed = []
    for await (const call of parser.parse()) parsed.push(call)

    expect(getCalls()).toBe(1)
    expect(loggedCodes()).toEqual([])
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({ model: 'openai/gpt-4o', costUSD: 1.5, timestamp: '2026-01-05T12:00:00.000Z' })
    await expect(vercelGateway.discoverSessions()).resolves.toEqual([
      { path: 'vercel-ai-gateway:report', project: 'Vercel AI Gateway', provider: 'vercel-gateway' },
    ])
  })

  it('preserves abort identity at the standalone Promise parser boundary', async () => {
    const abort = new ScanAbortedError({ message: 'standalone scan stopped' })
    const parser = vercelGateway.createSessionParser(
      { path: 'vercel-ai-gateway:report', project: 'Vercel AI Gateway', provider: 'vercel-gateway' },
      new Set(),
      RANGE,
      { fetchGatewayReport: () => Effect.fail(abort) },
    )

    await expect(parser.parse().next()).rejects.toBe(abort)
  })

  it('consumes the captured report Effect and deduplicates repeated model-day rows', async () => {
    const seenKeys = new Set<string>()
    const rows: ReportRow[] = [
      { day: '2026-01-05', model: 'openai/gpt-4o', total_cost: 1.5, input_tokens: 10, output_tokens: 20 },
      { day: '2026-01-05', model: 'openai/gpt-4o', total_cost: 2, input_tokens: 12, output_tokens: 22 },
      { day: '2026-01-06', model: 'openai/gpt-4o', total_cost: 0.5, input_tokens: 5, output_tokens: 5 },
    ]
    let calls = 0
    const parser = vercelGateway.createSessionParser(
      { path: 'vercel-ai-gateway:report', project: 'Vercel AI Gateway', provider: 'vercel-gateway' },
      seenKeys,
      RANGE,
      {
        gatewayEnabled: true,
        fetchGatewayReport: () => {
          calls += 1
          return Effect.succeed(rows)
        },
      },
    )

    const parsed = await Effect.runPromise(Stream.runCollect(gatewayStream(parser)))

    expect(calls).toBe(1)
    expect(Array.from(parsed)).toHaveLength(2)
    expect(seenKeys).toEqual(
      new Set(['vercel-gateway:2026-01-05:openai/gpt-4o', 'vercel-gateway:2026-01-06:openai/gpt-4o']),
    )
  })

  it('preserves the scan abort error from the native report capability', async () => {
    const abort = new ScanAbortedError({ message: 'gateway scan stopped' })
    const parser = vercelGateway.createSessionParser(
      { path: 'vercel-ai-gateway:report', project: 'Vercel AI Gateway', provider: 'vercel-gateway' },
      new Set(),
      RANGE,
      { gatewayEnabled: true, fetchGatewayReport: () => Effect.fail(abort) },
    )

    await expect(Effect.runPromise(Stream.runCollect(gatewayStream(parser)))).rejects.toBe(abort)
  })

  it('runs the report capability finalizer when native stream consumption is interrupted', async () => {
    const started = deferred<undefined>()
    let finalized = false
    const parser = vercelGateway.createSessionParser(
      { path: 'vercel-ai-gateway:report', project: 'Vercel AI Gateway', provider: 'vercel-gateway' },
      new Set(),
      RANGE,
      {
        gatewayEnabled: true,
        fetchGatewayReport: () =>
          Effect.acquireUseRelease(
            Effect.sync(() => started.resolve(undefined)),
            () => Effect.never,
            () =>
              Effect.sync(() => {
                finalized = true
              }),
          ),
      },
    )
    const fiber = Effect.runFork(Stream.runCollect(gatewayStream(parser)))

    await started.promise
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(finalized).toBe(true)
  })
})
