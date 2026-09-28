import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Schedule from 'effect/Schedule'
import * as TestClock from 'effect/testing/TestClock'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  DbWorkerClient,
  nextRespawnAttempt,
  RESPAWN_BACKOFF_BASE_MS,
  RESPAWN_BACKOFF_CAP_MS,
  RESPAWN_BACKOFF_RESET_AFTER_MS,
  respawnBackoffDelayForAttempt,
  type DbWorkerPort,
} from '../src/main/db-worker/client.js'
import { DbWorkerContext } from '../src/main/db-worker/context.js'
import type { DbWorkerEvent } from '../src/main/db-worker/protocol.js'
import { Env } from '../src/main/env.js'
import { OperationalLog, type OperationalLogSink, SCAN_DURATION_COUNTER } from '../src/main/operational-log.js'
import { HttpFetch } from '../src/main/pipeline/fetch-utils.js'
import { runScan, ScanAbortedError, type ScanMetadata } from '../src/main/pipeline/scan.js'

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), 'watchtower-dbworker-'))
}

function okFetch(body: unknown): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as typeof fetch
}

function throwingFetch(message = 'offline'): typeof fetch {
  return (async () => {
    throw new Error(message)
  }) as unknown as typeof fetch
}

describe('DbWorkerContext ops (ADR 0023)', () => {
  let dir = ''
  let ctx: DbWorkerContext | null = null
  const events: DbWorkerEvent[] = []

  function open(): DbWorkerContext {
    dir = tempDataDir()
    ctx = new DbWorkerContext({ dbPath: join(dir, 'ledger.db'), dataDir: dir, cacheDir: join(dir, 'cache') }, event => {
      events.push(event)
    })
    return ctx
  }

  afterEach(async () => {
    events.length = 0
    try {
      await ctx?.close()
    } catch {
      /* already closed */
    }
    ctx = null
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('reports an unscanned status on a fresh ledger', async () => {
    const status = (await open().dispatch('store:status', [])) as { scanned: boolean }
    expect(status.scanned).toBe(false)
  })

  it('round-trips the refresh cadence and reschedules without throwing', async () => {
    const c = open()
    expect(await c.dispatch('cadence:get', [])).toBe('1m')
    expect(await c.dispatch('cadence:set', ['5m'])).toBe('5m')
    expect(await c.dispatch('cadence:get', [])).toBe('5m')
  })

  it('delays cadence ticks and cancels the prior schedule when reconfigured', async () => {
    vi.useFakeTimers()
    const c = open()
    const triggerScan = vi
      .spyOn(c as unknown as { triggerBackgroundScan: () => Promise<void> }, 'triggerBackgroundScan')
      .mockResolvedValue(undefined)

    try {
      await c.dispatch('cadence:set', ['30s'])
      await vi.advanceTimersByTimeAsync(29_999)
      expect(triggerScan).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(triggerScan).toHaveBeenCalledTimes(1)

      await c.dispatch('cadence:set', ['1m'])
      await vi.advanceTimersByTimeAsync(30_000)
      expect(triggerScan).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(triggerScan).toHaveBeenCalledTimes(2)

      await c.dispatch('cadence:set', ['manual'])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(triggerScan).toHaveBeenCalledTimes(2)
    } finally {
      await c.close()
      vi.useRealTimers()
    }
  })

  it('writes model aliases with a config:changed event and validates input', async () => {
    const c = open()
    expect(await c.dispatch('models:addAlias', ['foo-model', 'gpt-4'])).toEqual({ ok: true })
    expect(events).toContainEqual({ event: 'config:changed' })
    expect(await c.dispatch('models:getAliases', [])).toEqual([{ model: 'foo-model', aliasOf: 'gpt-4' }])
    await expect(c.dispatch('models:addAlias', ['', 'gpt-4'])).rejects.toThrow(/non-empty/)
    expect(await c.dispatch('models:removeAlias', ['foo-model'])).toEqual({ ok: true })
    expect(await c.dispatch('models:getAliases', [])).toEqual([])
  })

  it('writes price overrides and validates input', async () => {
    const c = open()
    expect(await c.dispatch('models:setPrice', ['foo-model', 1, 2])).toEqual({ ok: true })
    expect(await c.dispatch('models:getPriceOverrides', [])).toEqual([
      { model: 'foo-model', inputPricePerMillion: 1, outputPricePerMillion: 2 },
    ])
    await expect(c.dispatch('models:setPrice', ['foo-model', -1, 2])).rejects.toThrow(/non-negative/)
    expect(await c.dispatch('models:removePriceOverride', ['foo-model'])).toEqual({ ok: true })
  })

  it('records skill dismissals', async () => {
    const c = open()
    expect(await c.dispatch('skills:dismiss', [{ source: 'bash', name: 'git commit', reason: 'one-off' }])).toEqual({
      ok: true,
    })
  })

  it('answers an empty overview with a null dataStart', async () => {
    const payload = (await open().dispatch('overview:query', [{ period: 'today' }])) as { dataStart: null }
    expect(payload.dataStart).toBeNull()
  })

  it('serves currency reads locally and rejects bogus codes', async () => {
    const c = open()
    expect(await c.dispatch('currency:get', [])).toMatchObject({ code: 'USD', rate: 1 })
    expect(Array.isArray(await c.dispatch('currency:list', []))).toBe(true)
    await expect(c.dispatch('currency:set', ['ZZZ'])).rejects.toThrow(/ISO 4217/)
  })

  it('persists the local ledger MCP startup mode and defaults to on-demand', async () => {
    const c = open()
    expect(await c.dispatch('ledger-mcp:startup:get', [])).toBe('on-demand')
    expect(await c.dispatch('ledger-mcp:startup:set', ['at-launch'])).toBe('at-launch')
    expect(await c.dispatch('ledger-mcp:startup:get', [])).toBe('at-launch')
    expect(await c.dispatch('ledger-mcp:startup:set', ['invalid'])).toBe('on-demand')
  })

  it('reports settings sizes for the temp data dir', async () => {
    const info = (await open().dispatch('settings:info', [])) as { dataDir: string; dbSize: number }
    expect(info.dataDir).toBe(dir)
    expect(info.dbSize).toBeGreaterThan(0)
  })

  it('scan:abort is a no-op without a running scan and unknown ops throw', async () => {
    const c = open()
    await expect(c.dispatch('scan:abort', [])).resolves.toBeNull()
    await expect(c.dispatch('unknown:op', [])).rejects.toThrow(/unknown db-worker op/)
  })

  it('emits oplog scan lifecycle records over the host channel (#128)', async () => {
    const c = open()
    await expect(c.dispatch('scan:start', [])).resolves.toEqual({ ok: true })
    const oplogs = events.filter(event => event.event === 'oplog')
    expect(oplogs[0]).toMatchObject({ level: 'info', logEvent: 'scan.start', fields: { op: 'scan' } })
    // Discovery reads the real provider dirs, so counts vary per machine —
    // assert the shape (allowlisted totals), not the values.
    const finish = oplogs.find(
      event => event.event === 'oplog' && (event as { logEvent: string }).logEvent === 'scan.finish',
    )
    expect(finish).toMatchObject({ level: 'info' })
    const fields = (finish as { fields: Record<string, unknown> }).fields
    expect(fields['op']).toBe('scan')
    for (const key of ['ported', 'unparsed', 'failed']) {
      expect(typeof fields[key]).toBe('number')
    }
  })

  it('shuts down idempotently for the quit path', async () => {
    const c = open()
    await expect(c.dispatch('shutdown', [])).resolves.toBeNull()
    await expect(c.dispatch('shutdown', [])).resolves.toBeNull()
  })

  it('waits for the scoped scan before closing the ledger', async () => {
    const c = open()
    let resolveScan!: (metadata: ScanMetadata) => void
    const scanResult = new Promise<ScanMetadata>(resolve => {
      resolveScan = resolve
    })
    const scanEffect = Effect.tryPromise({ try: () => scanResult, catch: cause => cause })
    const performScan = vi
      .spyOn(c as unknown as { performScan: (...args: never[]) => Effect.Effect<ScanMetadata, unknown> }, 'performScan')
      .mockReturnValue(scanEffect)
    const request = c.dispatch('scan:start', [])
    await vi.waitFor(() => expect(performScan).toHaveBeenCalledOnce())

    let scanSettled = false
    void request.then(
      () => {
        scanSettled = true
      },
      () => {
        scanSettled = true
      },
    )
    let closed = false
    const closing = c.close().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(scanSettled).toBe(false)
    expect(closed).toBe(false)

    resolveScan({
      scanId: 'test',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      portedFiles: 0,
      unchangedFiles: 0,
      failedFiles: 0,
      perProvider: [],
      aborted: false,
    })
    await expect(request).resolves.toEqual({ ok: true })
    await closing
    expect(closed).toBe(true)
  })

  it('scan:abort interrupts the running scan fiber and maps to {ok:false, aborted:true}', async () => {
    const c = open()
    const scanResult = new Promise<ScanMetadata>(() => {})
    const scanEffect = Effect.tryPromise({ try: () => scanResult, catch: cause => cause })
    vi.spyOn(
      c as unknown as { performScan: (...args: never[]) => Effect.Effect<ScanMetadata, unknown> },
      'performScan',
    ).mockReturnValue(scanEffect)
    const request = c.dispatch('scan:start', [])
    await vi.waitFor(() => expect((c as unknown as { scanFiber: unknown }).scanFiber).not.toBeNull())
    await expect(c.dispatch('scan:start', [])).resolves.toEqual({ ok: false, alreadyRunning: true })
    await expect(c.dispatch('scan:abort', [])).resolves.toBeNull()
    await expect(request).resolves.toMatchObject({ ok: false, aborted: true })
    expect(events).toContainEqual({ event: 'scan:error', manual: true, message: 'scan aborted' })
  })

  it('ScanAbortedError TaggedError preserves instanceof, name, message, _tag (parser name-check)', () => {
    const err = new ScanAbortedError({ message: 'scan aborted' })
    // instanceof (class NAME preserved) — Promise-boundary seams + context envelope
    expect(err).toBeInstanceOf(ScanAbortedError)
    expect(err).toBeInstanceOf(Error)
    // parser.ts safeEmitDelta re-throws BY NAME (~lines 68-74, forbidden, never edited)
    expect((err as Error).name).toBe('ScanAbortedError')
    expect((err as unknown as { _tag: string })._tag).toBe('ScanAbortedError')
    expect(err.message).toBe('scan aborted')
    // Simulated parser check (mirrors `err?.name === 'ScanAbortedError'`)
    const rethrowsByName = (e: unknown): boolean => (e as Error | undefined)?.name === 'ScanAbortedError'
    expect(rethrowsByName(err)).toBe(true)
    expect(rethrowsByName(new Error('boom'))).toBe(false)
  })

  it('typed ScanAbortedError without the flag maps to envelope (catchTag path, no cooperative seam)', async () => {
    const c = open()
    // Fail with the TAGGED error directly — flag stays false, proving the typed
    // `_tag` path (Effect-native `catchTag` in `performScan`) maps without the
    // cooperative `scanAbortFlag` seam. Envelopes stay byte-identical.
    vi.spyOn(
      c as unknown as { performScan: (...args: never[]) => Effect.Effect<ScanMetadata, unknown> },
      'performScan',
    ).mockReturnValue(Effect.fail(new ScanAbortedError({ message: 'scan aborted' })))
    const result = (await c.dispatch('scan:start', [])) as { ok: boolean; aborted: boolean; error: string }
    expect(result).toMatchObject({ ok: false, aborted: true })
    expect(result.error).toBe('scan aborted')
    expect((c as unknown as { scanAbortFlag: boolean }).scanAbortFlag).toBe(false)
    expect(events).toContainEqual({ event: 'scan:error', manual: true, message: 'scan aborted' })
    expect(events).toContainEqual(expect.objectContaining({ event: 'oplog', logEvent: 'scan.abort', level: 'warn' }))
    expect(events.filter(event => event.event === 'store:changed')).toHaveLength(0)
  })

  it('waits for a cancelled FX request before closing the ledger', async () => {
    let resolveResponse!: (response: Response) => void
    let requestSignal: AbortSignal | undefined
    const originalFetch = globalThis.fetch
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal as AbortSignal | undefined
        return new Promise<Response>(resolve => {
          resolveResponse = resolve
        })
      }),
    )
    const completeResponse = (): void =>
      resolveResponse?.({
        ok: true,
        status: 200,
        json: async () => ({ rates: { EUR: 0.9 } }),
      } as Response)

    try {
      const c = open()
      await c.dispatch('currency:set', ['EUR'])
      await vi.waitFor(() => expect(requestSignal).toBeDefined())

      let closed = false
      const closing = c.close().then(() => {
        closed = true
      })
      await vi.waitFor(() => expect(requestSignal?.aborted).toBe(true))
      expect(closed).toBe(false)

      completeResponse()
      await closing
      expect(closed).toBe(true)
      await expect(c.dispatch('currency:get', [])).rejects.toThrow(/shutting down/)
    } finally {
      completeResponse()
      vi.stubGlobal('fetch', originalFetch)
    }
  })

  it('pricing:refresh runs the Effect path and maps typed errors to {ok:false}', async () => {
    const pricingCacheDir = mkdtempSync(join(tmpdir(), 'watchtower-pricing-wiring-'))
    process.env['WATCHTOWER_CACHE_DIR'] = pricingCacheDir
    const originalFetch = globalThis.fetch
    try {
      const c = open()
      vi.stubGlobal(
        'fetch',
        vi.fn(
          okFetch({
            'wiring-test-model': { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
          }),
        ),
      )
      await expect(c.dispatch('pricing:refresh', [])).resolves.toEqual({ ok: true })

      vi.stubGlobal('fetch', vi.fn(throwingFetch()))
      const failed = (await c.dispatch('pricing:refresh', [])) as { ok: boolean; error?: string }
      expect(failed.ok).toBe(false)
      expect(typeof failed.error).toBe('string')
      expect(failed.error).toContain('offline')
    } finally {
      vi.stubGlobal('fetch', originalFetch)
      delete process.env['WATCHTOWER_CACHE_DIR']
      rmSync(pricingCacheDir, { recursive: true, force: true })
    }
  })

  it('currency:set refreshes via the Effect FX path and emits currency:changed', async () => {
    const originalFetch = globalThis.fetch
    const seenUrls: string[] = []
    const eurRates = okFetch({ rates: { EUR: 0.9 } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        seenUrls.push(String(input))
        return eurRates(input, {})
      }) as unknown as typeof fetch,
    )
    try {
      const c = open()
      const immediate = (await c.dispatch('currency:set', ['EUR'])) as { code: string }
      expect(immediate.code).toBe('EUR')
      await vi.waitFor(() => {
        expect(seenUrls.some(url => url.includes('frankfurter') && url.includes('EUR'))).toBe(true)
        expect(events.some(event => event.event === 'currency:changed')).toBe(true)
      })
      const changed = events.find(event => event.event === 'currency:changed') as {
        event: string
        currency: { rate: number }
      }
      expect(changed.currency.rate).toBe(0.9)
    } finally {
      vi.stubGlobal('fetch', originalFetch)
    }
  })
})

describe('SCAN_DURATION_COUNTER wiring (Wave 5, fake/throwing sinks, TestClock)', () => {
  type SinkRecord = { level: string; event: string; fields: Record<string, unknown>; context: string }

  function makeFakeSink(): { sink: OperationalLogSink; records: SinkRecord[] } {
    const records: SinkRecord[] = []
    const sink: OperationalLogSink = {
      emit: (level, event, fields, context) => {
        records.push({ level, event, fields: { ...fields }, context })
      },
    }
    return { sink, records }
  }

  function testEnv(): ReturnType<typeof Env.layerWithValues> {
    return Env.layerWithValues({ vercelGatewayApiKey: null, pricingCacheTtlMs: Infinity })
  }

  function lifetimeOptions(): { range: { start: Date; end: Date }; provider: string } {
    // Empty-provider filter keeps these unit tests fast + deterministic (no real
    // provider dirs walked) while still exercising pricing + duration filing.
    // Real-filesystem success is already covered by the `#128` oplog test.
    return { range: { start: new Date(0), end: new Date() }, provider: '__wave5-empty-provider__' }
  }

  function provideScanLayers(
    program: Effect.Effect<ScanMetadata, ScanAbortedError | Error, HttpFetch | Env | OperationalLog>,
    sink: OperationalLogSink,
  ): Effect.Effect<ScanMetadata, ScanAbortedError | Error> {
    return program.pipe(
      Effect.provide(HttpFetch.layerWithFetch(throwingFetch())),
      Effect.provide(testEnv()),
      Effect.provide(OperationalLog.layerWithSink(sink)),
      Effect.provide(TestClock.layer()),
    )
  }

  function expectDurationFiled(records: SinkRecord[], outcome: 'success' | 'aborted' | 'failed'): void {
    expect(records).toHaveLength(1)
    expect(records[0]!.event).toBe(SCAN_DURATION_COUNTER)
    expect(records[0]!.fields).toMatchObject({ op: 'scan', outcome })
  }

  it('files success with outcome label via fake sink (TestClock governs Clock)', async () => {
    const { sink, records } = makeFakeSink()
    const program = provideScanLayers(runScan(lifetimeOptions()), sink)
    const metadata = await Effect.runPromise(program)
    expect(metadata.aborted).toBe(false)
    expect(typeof metadata.scanId).toBe('string')
    expect(records[0]!.level).toBe('info')
    // Amount is wall duration ms via Clock.currentTimeMillis (TestClock => virtual,
    // deterministic 0 without concurrent adjust — proves Clock, not Date.now).
    expect(typeof records[0]!.fields['count']).toBe('number')
    expect(Number(records[0]!.fields['count'])).toBeGreaterThanOrEqual(0)
    // Outcome labels only (no payloads, no paths); `outcome` is dropped by the
    // file allowlist today (same as probe `status` / fetch `reason` — NOT widened).
    expectDurationFiled(records, 'success')
  })

  it('files aborted with outcome label via fake sink (abort flag + onDelta seam)', async () => {
    const { sink, records } = makeFakeSink()
    const program = provideScanLayers(
      runScan(lifetimeOptions(), undefined, { isAborted: () => true }, async () => {}),
      sink,
    )
    const error = await Effect.runPromise(program.pipe(Effect.flip))
    expect(error).toBeInstanceOf(ScanAbortedError)
    expect((error as ScanAbortedError)._tag).toBe('ScanAbortedError')
    expect((error as Error).message).toBe('scan aborted')
    expect((error as Error).name).toBe('ScanAbortedError')
    expectDurationFiled(records, 'aborted')
  })

  it('files failed with outcome label when the scan dies (defect stays in Cause)', async () => {
    const { sink, records } = makeFakeSink()
    // Omit Env on purpose: `loadPricingEffect` dies with missing-service defect.
    // `onExit` still files `failed` (defects are read for the label, never converted).
    const program = runScan(lifetimeOptions()).pipe(
      Effect.provide(HttpFetch.layerWithFetch(throwingFetch())),
      Effect.provide(OperationalLog.layerWithSink(sink)),
      Effect.provide(TestClock.layer()),
    )
    const exit = await Effect.runPromise(Effect.exit(program))
    expect(exit._tag).toBe('Failure')
    expectDurationFiled(records, 'failed')
  })

  it('a throwing sink never breaks success or abort (never-throw in fibers)', async () => {
    const throwing: OperationalLogSink = {
      emit: () => {
        throw new Error('sink boom')
      },
    }
    const okProgram = provideScanLayers(runScan(lifetimeOptions()), throwing)
    await expect(Effect.runPromise(okProgram)).resolves.toMatchObject({ aborted: false })

    const abortProgram = provideScanLayers(
      runScan(lifetimeOptions(), undefined, { isAborted: () => true }, async () => {}),
      throwing,
    )
    const error = await Effect.runPromise(abortProgram.pipe(Effect.flip))
    expect(error).toBeInstanceOf(ScanAbortedError)
    expect((error as Error).message).toBe('scan aborted')
  })
})

/** In-memory stand-in for a worker thread: echoes requests back on demand. */
class FakeWorker {
  listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  posted: unknown[] = []

  constructor(private behavior: (req: { id: number; op: string; args: unknown[] }) => void) {}

  postMessage(message: unknown): void {
    this.posted.push(message)
    // Async like a real thread hop: the request stays pending until the test
    // drives the fake's next step (response, error, or exit).
    queueMicrotask(() => this.behavior(message as { id: number; op: string; args: unknown[] }))
  }

  on(event: string, listener: (...args: unknown[]) => void): unknown {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args)
  }

  terminate(): Promise<number> {
    return Promise.resolve(0)
  }
}

type Responder = (fake: FakeWorker, req: { id: number; op: string; args: unknown[] }) => void

const echoResponder: Responder = (fake, req) => {
  fake.emit('message', { id: req.id, ok: true, data: { op: req.op, args: req.args } })
}

function makeClient(
  responder: Responder = echoResponder,
  onFake?: (fake: FakeWorker) => void,
): { client: DbWorkerClient; fakes: FakeWorker[] } {
  const fakes: FakeWorker[] = []
  const client = new DbWorkerClient(
    { dbPath: ':memory:', dataDir: ':memory:', cacheDir: ':memory:' },
    'fake-worker.js',
    () => {
      const fake = new FakeWorker(req => responder(fake, req))
      fakes.push(fake)
      onFake?.(fake)
      return fake as unknown as DbWorkerPort
    },
  )
  return { client, fakes }
}

describe('DbWorkerClient request/response correlation', () => {
  it('resolves concurrent requests to the right caller', async () => {
    const { client } = makeClient()
    const [a, b] = await Promise.all([
      client.request('overview:query', { period: 'today' }),
      client.request('currency:get'),
    ])
    expect(a).toEqual({ op: 'overview:query', args: [{ period: 'today' }] })
    expect(b).toEqual({ op: 'currency:get', args: [] })
    await client.terminate()
  })

  it('rejects when the worker reports an op error', async () => {
    const { client } = makeClient((fake, req) => {
      fake.emit('message', { id: req.id, ok: false, error: 'boom' })
    })
    await expect(client.request('models:addAlias', ['', ''])).rejects.toThrow('boom')
    await client.terminate()
  })

  it('routes worker broadcasts to event listeners', async () => {
    const { client, fakes } = makeClient()
    const seen: DbWorkerEvent[] = []
    client.onEvent(event => {
      seen.push(event)
    })
    fakes[0]!.emit('message', { event: 'store:changed', metadata: { portedFiles: 1 } })
    expect(seen).toEqual([{ event: 'store:changed', metadata: { portedFiles: 1 } }])
    await client.terminate()
  })

  it('rejects in-flight requests and respawns after a live worker exits', async () => {
    const spawn = vi.fn()
    const { client, fakes } = makeClient(echoResponder, () => {
      spawn()
    })
    expect(spawn).toHaveBeenCalledTimes(1)
    fakes[0]!.emit('message', { event: 'ready' })
    await expect(client.ready).resolves.toBeUndefined()
    const pending = client.request('overview:query', {})
    fakes[0]!.emit('exit', 1)
    await expect(pending).rejects.toThrow(/exited unexpectedly/)
    // Backoff (Wave 7 §4.4): the first post-ready crash respawns fast
    // (~0.8–1.2s jittered), not synchronously — wait out the Clock delay.
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(2), { timeout: 5000 })
    // The respawned worker serves new requests once it is ready.
    fakes[1]!.emit('message', { event: 'ready' })
    await expect(client.request('currency:get')).resolves.toEqual({ op: 'currency:get', args: [] })
    await client.terminate()
  })

  it('resolves ready on the boot handshake', async () => {
    const { client, fakes } = makeClient()
    fakes[0]!.emit('message', { event: 'ready' })
    await expect(client.ready).resolves.toBeUndefined()
    await client.terminate()
  })

  it('never respawns a worker that failed to boot and rejects with its error', async () => {
    const spawn = vi.fn()
    const { client, fakes } = makeClient(echoResponder, () => {
      spawn()
    })
    fakes[0]!.emit('message', { event: 'init-error', error: 'cannot open ledger.db' })
    await expect(client.ready).rejects.toThrow('cannot open ledger.db')
    const pending = client.request('overview:query', {})
    fakes[0]!.emit('exit', 1)
    await expect(pending).rejects.toThrow('cannot open ledger.db')
    // No hot loop: a worker that never lived is not recreated.
    expect(spawn).toHaveBeenCalledTimes(1)
    await client.terminate()
  })

  it('settles ready on a pre-boot thread error without respawning', async () => {
    const spawn = vi.fn()
    const { client, fakes } = makeClient(echoResponder, () => {
      spawn()
    })
    fakes[0]!.emit('error', new Error('thread blew up during init'))
    await expect(client.ready).rejects.toThrow('thread blew up during init')
    fakes[0]!.emit('exit', 1)
    // The exit that follows a failed boot must not recreate the worker.
    expect(spawn).toHaveBeenCalledTimes(1)
    await client.terminate()
  })

  it('coalesces identical concurrent reads into one execution', async () => {
    const { client, fakes } = makeClient()
    const [a, b] = await Promise.all([
      client.request('overview:query', { period: 'today' }),
      client.request('overview:query', { period: 'today' }),
    ])
    expect(fakes[0]!.posted).toHaveLength(1)
    expect(a).toEqual(b)
    await client.terminate()
  })

  it('does not coalesce distinct args or writes', async () => {
    const { client, fakes } = makeClient()
    await Promise.all([
      client.request('overview:query', { period: 'today' }),
      client.request('overview:query', { period: 'week' }),
      client.request('scan:start'),
      client.request('scan:start'),
    ])
    expect(fakes[0]!.posted).toHaveLength(4)
    await client.terminate()
  })

  it('shutdown asks the worker to close and terminates the thread', async () => {
    const { client, fakes } = makeClient()
    fakes[0]!.emit('message', { event: 'ready' })
    await client.shutdown()
    // The first post is the graceful close op; the thread is then gone.
    expect(fakes[0]!.posted[0]).toMatchObject({ op: 'shutdown', args: [] })
    await expect(client.request('currency:get')).rejects.toThrow(/shut down|unavailable/)
  })
})

describe('DbWorkerClient shutdown deadline (Effect Clock, §5.1)', () => {
  it('a hanging graceful ack resolves after the Clock deadline and terminates exactly once', async () => {
    const timeoutMs = 2000
    // Hanging responder: the graceful `shutdown` ack never arrives.
    const { client, fakes } = makeClient(() => {})
    const worker = fakes[0]!
    worker.emit('message', { event: 'ready' })
    await client.ready
    const terminateSpy = vi.spyOn(worker, 'terminate')
    const pending = client.request('currency:get')
    const rejected = expect(pending).rejects.toThrow('data worker shut down')
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(client.shutdownEffect(timeoutMs))
        yield* TestClock.adjust(timeoutMs)
        yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    await rejected
    // The in-flight read went out first; the graceful close op follows it.
    expect(worker.posted).toContainEqual(expect.objectContaining({ op: 'shutdown', args: [] }))
    expect(terminateSpy).toHaveBeenCalledTimes(1)
    // The Promise entry point stays idempotent on top: no second terminate.
    await client.shutdown()
    expect(terminateSpy).toHaveBeenCalledTimes(1)
    await expect(client.request('currency:get')).rejects.toThrow(/shut down|unavailable/)
  })

  it('a graceful ack wins the deadline without advancing the clock', async () => {
    const { client, fakes } = makeClient()
    const worker = fakes[0]!
    worker.emit('message', { event: 'ready' })
    await client.ready
    const terminateSpy = vi.spyOn(worker, 'terminate')
    await Effect.runPromise(client.shutdownEffect(2000).pipe(Effect.provide(TestClock.layer())))
    expect(worker.posted[0]).toMatchObject({ op: 'shutdown', args: [] })
    expect(terminateSpy).toHaveBeenCalledTimes(1)
  })

  it('still resolves when the graceful send itself fails (no live worker)', async () => {
    const { client, fakes } = makeClient()
    const worker = fakes[0]!
    // Boot failure, never lived: the exit leaves no worker behind.
    worker.emit('message', { event: 'init-error', error: 'cannot open ledger.db' })
    await expect(client.ready).rejects.toThrow('cannot open ledger.db')
    worker.emit('exit', 1)
    const terminateSpy = vi.spyOn(worker, 'terminate')
    // `send('shutdown')` rejects (no worker) — teardown still runs, shutdown still resolves.
    await expect(client.shutdown()).resolves.toBeUndefined()
    expect(terminateSpy).not.toHaveBeenCalled()
    await expect(client.shutdown()).resolves.toBeUndefined()
  })
})

describe('DbWorkerClient crash-respawn backoff (Wave 7 §4.4, TestClock)', () => {
  it('restarts the streak on the first crash and after sustained health', () => {
    const now = 1_000_000
    expect(nextRespawnAttempt(0, now, null)).toBe(1)
    // Rapid follow-up crashes keep counting up the streak.
    expect(nextRespawnAttempt(1, now + 1_000, now)).toBe(2)
    expect(nextRespawnAttempt(4, now + 5_000, now)).toBe(5)
    // A worker that stayed up past the quiet period clears the streak.
    expect(nextRespawnAttempt(7, now + RESPAWN_BACKOFF_RESET_AFTER_MS + 1, now)).toBe(1)
    // Exactly at the boundary still counts — reset needs MORE than quiet.
    expect(nextRespawnAttempt(7, now + RESPAWN_BACKOFF_RESET_AFTER_MS, now)).toBe(8)
  })

  it('grows exponentially with jitter bounds and caps at tens of seconds', async () => {
    const nominal = (attempt: number): number =>
      Math.min(RESPAWN_BACKOFF_BASE_MS * 2 ** (attempt - 1), RESPAWN_BACKOFF_CAP_MS)
    for (const attempt of [1, 2, 3, 4, 5, 6, 8, 12]) {
      const ms: number = Duration.toMillis(await Effect.runPromise(respawnBackoffDelayForAttempt(attempt)))
      const expected: number = nominal(attempt)
      expect(ms).toBeGreaterThanOrEqual(expected * 0.8)
      expect(ms).toBeLessThanOrEqual(expected * 1.2)
    }
    // Past the knee the delay pins to the cap band, never minutes of dead UI.
    const capped: number = Duration.toMillis(await Effect.runPromise(respawnBackoffDelayForAttempt(20)))
    expect(capped).toBeGreaterThanOrEqual(RESPAWN_BACKOFF_CAP_MS * 0.8)
    expect(capped).toBeLessThanOrEqual(RESPAWN_BACKOFF_CAP_MS * 1.2)
  })

  it('sleeps on the TestClock: no respawn before 0.8x nominal, respawned by 1.2x', async () => {
    const { client, fakes } = makeClient()
    fakes[0]!.emit('message', { event: 'ready' })
    await client.ready
    // Attempt 1: nominal 1s → hold at 799ms, released by 1200ms.
    const before = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(client.respawnAfterCrashEffect(1, '1'))
        yield* TestClock.adjust(799)
        const count = yield* Effect.sync(() => fakes.length)
        yield* TestClock.adjust(401)
        yield* Fiber.join(fiber)
        return count
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(before).toBe(1)
    expect(fakes.length).toBe(2)
    await client.terminate()
  })

  it('backs a deep streak off toward the cap band on the TestClock', async () => {
    const { client, fakes } = makeClient()
    fakes[0]!.emit('message', { event: 'ready' })
    await client.ready
    // Attempt 5: nominal 16s → hold at 12.799s, released by 19.2s.
    const before = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(client.respawnAfterCrashEffect(5, '1'))
        yield* TestClock.adjust(12_799)
        const count = yield* Effect.sync(() => fakes.length)
        yield* TestClock.adjust(6_401)
        yield* Fiber.join(fiber)
        return count
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(before).toBe(1)
    expect(fakes.length).toBe(2)
    await client.terminate()
  })

  it('skips the respawn when torn down during the backoff window', async () => {
    const spawn = vi.fn()
    const { client, fakes } = makeClient(echoResponder, () => {
      spawn()
    })
    fakes[0]!.emit('message', { event: 'ready' })
    await client.ready
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(client.respawnAfterCrashEffect(1, '1'))
        yield* TestClock.adjust(100)
        yield* Effect.tryPromise({ try: () => client.shutdown(), catch: cause => cause })
        yield* TestClock.adjust(5_000)
        yield* Fiber.join(fiber)
      }).pipe(Effect.provide(TestClock.layer())),
    )
    expect(spawn).toHaveBeenCalledTimes(1)
  })
})

describe('DbWorkerContext cadence jitter (Wave 7 §4.4)', () => {
  it('spaces repeat ticks within ±20% of the preset and holds the nominal count', async () => {
    vi.useFakeTimers()
    const dir = tempDataDir()
    const ctx = new DbWorkerContext(
      { dbPath: join(dir, 'ledger.db'), dataDir: dir, cacheDir: join(dir, 'cache') },
      () => {},
    )
    const tickTimes: number[] = []
    const triggerScan = vi
      .spyOn(ctx as unknown as { triggerBackgroundScan: () => Promise<void> }, 'triggerBackgroundScan')
      .mockImplementation(async () => {
        tickTimes.push(Date.now())
      })
    try {
      await ctx.dispatch('cadence:set', ['30s'])
      await vi.advanceTimersByTimeAsync(300_000)
      // Every repeat gap is one independent jittered draw in [24s, 36s]
      // (`Date` is real-walled under these fake timers, so gaps only —
      // absolute first-tick exactness is the pre-existing timing test's job).
      expect(tickTimes.length).toBeGreaterThan(1)
      for (let i = 1; i < tickTimes.length; i++) {
        const gap = tickTimes[i]! - tickTimes[i - 1]!
        expect(gap).toBeGreaterThanOrEqual(24_000)
        expect(gap).toBeLessThanOrEqual(36_000)
      }
      // Closed-loop nominal rate: ~10 ticks per 300s (renewal std < 0.4, so
      // [8, 12] is wide). `fixed+jittered` fails this (catch-up ticks ≈ 22);
      // `spaced+jittered` holds it — the carrier verdict in `context.ts`.
      expect(tickTimes.length).toBeGreaterThanOrEqual(8)
      expect(tickTimes.length).toBeLessThanOrEqual(12)
      expect(triggerScan.mock.calls.length).toBe(tickTimes.length)
    } finally {
      await ctx.close()
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('samples the jittered spaced schedule: bounded ±20%, mean ≈ nominal', async () => {
    const ms: number = 30_000
    const schedule = Schedule.spaced(ms).pipe(Schedule.jittered)
    const delays: number[] = await Effect.runPromise(
      Effect.gen(function* () {
        const step = yield* Schedule.toStep(schedule)
        const out: number[] = []
        for (let i = 0; i < 100; i++) out.push(Duration.toMillis((yield* Effect.orDie(step(0, undefined)))[1]))
        return out
      }),
    )
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(ms * 0.8)
      expect(delay).toBeLessThanOrEqual(ms * 1.2)
    }
    const mean: number = delays.reduce((a: number, b: number) => a + b, 0) / delays.length
    expect(mean).toBeGreaterThanOrEqual(ms * 0.95)
    expect(mean).toBeLessThanOrEqual(ms * 1.05)
  })
})
