import { join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  cache: undefined as unknown,
  discovered: vi.fn(),
  getProvider: vi.fn(),
  fingerprint: vi.fn(),
  readLines: vi.fn(),
  readdir: vi.fn(),
  parserCreated: vi.fn(),
  saveCache: vi.fn(),
}))

vi.mock('fs/promises', () => ({
  lstat: vi.fn().mockRejectedValue(Object.assign(new Error('missing fixture path'), { code: 'ENOENT' })),
  readdir: (...args: unknown[]) => hooks.readdir(...args),
  readFile: vi.fn(),
  stat: vi.fn(),
}))

vi.mock('../src/infrastructure/ingestion/fs-utils.js', () => ({
  readSessionLines: (...args: unknown[]) => hooks.readLines(...args),
  readSessionLinesStream: (...args: unknown[]) =>
    Stream.fromAsyncIterable(hooks.readLines(...args) as AsyncIterable<string>, cause =>
      cause instanceof Error ? cause : new Error(String(cause)),
    ),
}))

vi.mock('../src/infrastructure/provider-adapters/index.js', () => ({
  discoverAllSessionsEffect: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => hooks.discovered(...args) as Promise<unknown>,
      catch: cause => cause as Error,
    }),
  getProviderEffect: (...args: unknown[]) =>
    Effect.tryPromise({
      try: () => hooks.getProvider(...args) as Promise<unknown>,
      catch: cause => cause as Error,
    }),
}))

vi.mock('../src/infrastructure/ingestion/session-cache.js', async () => {
  const Effect = await import('effect/Effect')
  return {
    beginColdHydration: vi.fn(),
    beginColdHydrationEffect: vi.fn(() => Effect.succeed({ waited: false, release: Effect.void })),
    cleanupOrphanedTempFiles: vi.fn(async () => undefined),
    cleanupOrphanedTempFilesEffect: vi.fn(() => Effect.void),
    computeEnvFingerprint: vi.fn(() => 'test-env'),
    DURABLE_PROVIDER_NAMES: new Set(),
    fingerprintFile: (...args: unknown[]) => hooks.fingerprint(...args),
    fingerprintFileEffect: (...args: unknown[]) =>
      Effect.tryPromise({
        try: () => hooks.fingerprint(...args) as Promise<unknown>,
        catch: cause => cause as Error,
      }),
    isCacheComplete: (cache: { complete?: boolean }) => cache.complete === true,
    loadCache: vi.fn(() => hooks.cache),
    loadCacheEffect: vi.fn(() => Effect.sync(() => hooks.cache as SessionCache)),
    reconcileFile: vi.fn(() => ({ action: 'modified' })),
    saveCache: (...args: unknown[]) => hooks.saveCache(...args),
    saveCacheEffect: (...args: unknown[]) =>
      Effect.tryPromise({ try: () => hooks.saveCache(...args), catch: cause => cause as Error }),
    sectionNeedsPrEvidenceReparse: vi.fn(() => false),
  }
})

vi.mock('../src/infrastructure/ingestion/cache-refresh-lock.js', async () => {
  const Effect = await import('effect/Effect')
  const handle = {
    release: async () => undefined,
    releaseEffect: Effect.void,
    verifyStillOwnerEffect: Effect.succeed(true),
  }
  return {
    acquireCacheRefreshLock: vi.fn(async () => ({ outcome: 'acquired', handle: { release: async () => undefined } })),
    acquireCacheRefreshLockEffect: vi.fn(() => Effect.succeed({ outcome: 'acquired', handle })),
  }
})

import { Env } from '../src/infrastructure/config/environment.js'
import { HttpFetch } from '../src/infrastructure/ingestion/fetch-utils.js'
import { captureScanPricing } from '../src/infrastructure/pricing/models.js'
import { clearSessionCache, parseAllSessionsEffect } from '../src/infrastructure/ingestion/parser.js'
import type { Provider } from '../src/infrastructure/provider-adapters/types.js'
import { ScanAbortedError } from '../src/core/ingestion/reconciliation/scan-control.js'
import type { CachedFile, SessionCache } from '../src/shared/schemas/session-cache.js'
import { runParseAllSessionsForTest } from './fixtures/parser-effects.js'

const source = (provider: string, path: string) => ({ provider, path, project: 'test-project' })

const priorFile: CachedFile = {
  fingerprint: { dev: 1, ino: 1, mtimeMs: 1, sizeBytes: 1 },
  mcpInventory: [],
  turns: [],
}

function makeCache(provider: string, paths: string[]): SessionCache {
  return {
    version: 7,
    complete: true,
    providers: {
      [provider]: {
        envFingerprint: 'test-env',
        files: Object.fromEntries(paths.map(path => [path, structuredClone(priorFile)])),
      },
    },
  } as SessionCache
}

function parsedCall() {
  return {
    provider: 'test-provider',
    model: 'test-model',
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    tools: [],
    bashCommands: [],
    timestamp: '2026-01-01T00:00:00.000Z',
    speed: 'standard' as const,
    deduplicationKey: 'test-provider:call-1',
    userMessage: 'test',
    sessionId: 'session-1',
  }
}

function withParserServices<A, E>(
  program: Effect.Effect<A, E, Env | HttpFetch | import('effect/FileSystem').FileSystem>,
): Effect.Effect<A, E, never> {
  return program.pipe(
    Effect.provide(Env.layer),
    Effect.provide(HttpFetch.layerWithFetch(globalThis.fetch)),
    Effect.provide(NodeFileSystem.layer),
  )
}

function ownedPendingDelta(
  pending: Promise<void>,
  start: () => void,
  stop: () => void,
  settled: () => void,
): Effect.Effect<void, Error> {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      let isSettled = false
      const drain = pending.then(
        () => {
          isSettled = true
          settled()
        },
        () => {
          isSettled = true
          settled()
        },
      )
      start()
      return { pending, drain, isSettled: () => isSettled }
    }),
    resource =>
      Effect.tryPromise({
        try: () => resource.pending,
        catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
      }),
    resource =>
      Effect.sync(() => {
        if (!resource.isSettled()) stop()
      }).pipe(Effect.ensuring(Effect.promise(() => resource.drain))),
  )
}

describe('parser cooperative stop', () => {
  beforeEach(() => {
    clearSessionCache()
    hooks.discovered.mockReset()
    hooks.getProvider.mockReset()
    hooks.fingerprint.mockReset()
    hooks.readLines.mockReset()
    hooks.readdir.mockReset()
    hooks.parserCreated.mockReset()
    hooks.saveCache.mockReset()
    hooks.cache = undefined
  })

  afterEach(() => {
    clearSessionCache()
    vi.unstubAllEnvs()
  })

  it('expires the in-memory session result from the Effect Clock', async () => {
    hooks.cache = makeCache('test-provider', [])
    hooks.discovered.mockResolvedValue([])
    const program = Effect.gen(function* () {
      yield* TestClock.setTime(1_000_000)
      yield* parseAllSessionsEffect()
      yield* TestClock.adjust(179_999)
      yield* parseAllSessionsEffect()
      yield* TestClock.adjust(1)
      yield* parseAllSessionsEffect()
    }).pipe(Effect.provide(TestClock.layer()))

    await Effect.runPromise(withParserServices(program))

    expect(hooks.discovered).toHaveBeenCalledTimes(2)
  })

  it('rethrows provider delta abort without turning the file into a failed cache result or starting the next file', async () => {
    const firstPath = '/test/one.session'
    const secondPath = '/test/two.session'
    const cache = makeCache('test-provider', [firstPath, secondPath])
    hooks.cache = cache
    hooks.discovered.mockResolvedValue([source('test-provider', firstPath), source('test-provider', secondPath)])
    hooks.fingerprint.mockResolvedValue({ dev: 2, ino: 2, mtimeMs: 2, sizeBytes: 2 })
    hooks.getProvider.mockResolvedValue({
      network: false,
      durableSources: false,
      createSessionParser: () => ({
        parse: async function* () {
          hooks.parserCreated()
          yield parsedCall()
        },
        parseStream: () =>
          Stream.fromEffect(
            Effect.sync(() => {
              hooks.parserCreated()
              return parsedCall()
            }),
          ),
      }),
    })
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    const onDelta = vi.fn(async () => {
      controller.abort(abort)
      throw abort
    })
    vi.stubEnv('WATCHTOWER_PROGRESS', '1')
    const progressWrites = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((() => true) as typeof process.stderr.write)

    try {
      await expect(
        runParseAllSessionsForTest(undefined, undefined, onDelta, undefined, controller.signal),
      ).rejects.toBe(abort)

      expect(hooks.parserCreated).toHaveBeenCalledOnce()
      expect(onDelta).toHaveBeenCalledOnce()
      const files = cache.providers['test-provider']?.files
      expect(files?.[firstPath]).toEqual(priorFile)
      expect(files?.[secondPath]).toEqual(priorFile)
      expect(files && Object.values(files).some(file => file.failed)).toBe(false)
      expect(hooks.saveCache).not.toHaveBeenCalled()
      const progress = progressWrites.mock.calls.map(([value]) => String(value)).join('')
      expect(progress).not.toContain('"state":"done"')
    } finally {
      progressWrites.mockRestore()
    }
  })

  it('rethrows Claude read abort without writing a failure marker or reading the next file', async () => {
    const projectDir = '/test/claude-project'
    const firstPath = `${projectDir}/one.jsonl`
    const secondPath = `${projectDir}/two.jsonl`
    const cache = makeCache('claude', [firstPath, secondPath])
    hooks.cache = cache
    hooks.discovered.mockResolvedValue([source('claude', projectDir)])
    hooks.fingerprint.mockResolvedValue({ dev: 2, ino: 2, mtimeMs: 2, sizeBytes: 2 })
    hooks.readdir.mockImplementation(async (path: string) => {
      if (path === projectDir) return ['one.jsonl', 'two.jsonl']
      throw new Error('missing directory')
    })
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    hooks.readLines.mockImplementation(async function* () {
      yield 'not json'
      throw abort
    })

    await expect(runParseAllSessionsForTest()).rejects.toBe(abort)

    expect(hooks.readLines).toHaveBeenCalledOnce()
    const files = cache.providers.claude?.files
    expect(files?.[firstPath]).toEqual(priorFile)
    expect(files?.[secondPath]).toEqual(priorFile)
    expect(files && Object.values(files).some(file => file.failed)).toBe(false)
    expect(hooks.saveCache).not.toHaveBeenCalled()
  })

  it('restores the prior Claude cache entry when scan stop arrives during delta publication', async () => {
    const projectDir = '/test/claude-project'
    const filePath = join(projectDir, 'one.jsonl')
    const cache = makeCache('claude', [filePath])
    hooks.cache = cache
    hooks.discovered.mockResolvedValue([source('claude', projectDir)])
    hooks.fingerprint.mockResolvedValue({ dev: 2, ino: 2, mtimeMs: 2, sizeBytes: 2 })
    hooks.readdir.mockImplementation(async (path: string) => (path === projectDir ? ['one.jsonl'] : []))
    hooks.readLines.mockImplementation(async function* () {
      yield JSON.stringify({ type: 'user', uuid: 'new-entry' })
    })
    const prior = structuredClone(cache.providers.claude?.files[filePath])
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted during publication' })
    const onDelta = vi.fn(async () => {
      controller.abort(abort)
      throw abort
    })

    await expect(runParseAllSessionsForTest(undefined, undefined, onDelta, undefined, controller.signal)).rejects.toBe(
      abort,
    )

    expect(onDelta).toHaveBeenCalledOnce()
    expect(cache.providers.claude?.files[filePath]).toEqual(prior)
    expect(cache.providers.claude?.files[filePath]?.failed).toBeUndefined()
    expect(hooks.saveCache).not.toHaveBeenCalled()
  })

  it('drains a pending Claude delta callback before restoring a replaced cache entry', async () => {
    const projectDir = '/test/claude-project'
    const filePath = join(projectDir, 'one.jsonl')
    const cache = makeCache('claude', [filePath])
    hooks.cache = cache
    hooks.discovered.mockResolvedValue([source('claude', projectDir)])
    hooks.fingerprint.mockResolvedValue({ dev: 2, ino: 2, mtimeMs: 2, sizeBytes: 2 })
    hooks.readdir.mockImplementation(async (path: string) => (path === projectDir ? ['one.jsonl'] : []))
    hooks.readLines.mockImplementation(async function* () {
      yield JSON.stringify({ type: 'user', sessionId: 'new-entry' })
    })
    const prior = structuredClone(cache.providers.claude?.files[filePath])
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted during pending publication' })
    let entered!: () => void
    let release!: () => void
    const callbackStarted = new Promise<void>(resolve => (entered = resolve))
    const callbackGate = new Promise<void>(resolve => (release = resolve))
    const onDelta = vi.fn(async () => {
      cache.providers.claude!.files[filePath] = { ...priorFile, failed: true }
      entered()
      await callbackGate
    })

    const scan = runParseAllSessionsForTest(undefined, undefined, onDelta, undefined, controller.signal)
    await callbackStarted
    controller.abort(abort)
    let settled = false
    void scan.then(
      () => (settled = true),
      () => (settled = true),
    )
    await Promise.resolve()
    expect(settled).toBe(false)
    release()

    await expect(scan).rejects.toBe(abort)
    expect(cache.providers.claude?.files[filePath]).toEqual(prior)
    expect(hooks.saveCache).not.toHaveBeenCalled()
  })

  it('restores the original Claude entry after fiber interruption drains delta publication', async () => {
    const projectDir = '/test/claude-project'
    const filePath = join(projectDir, 'one.jsonl')
    const cache = makeCache('claude', [filePath])
    const originalEntry = cache.providers.claude!.files[filePath]!
    const originalValue = structuredClone(originalEntry)
    hooks.cache = cache
    hooks.discovered.mockResolvedValue([source('claude', projectDir)])
    hooks.fingerprint.mockResolvedValue({ dev: 2, ino: 2, mtimeMs: 2, sizeBytes: 2 })
    hooks.readdir.mockImplementation(async (path: string) => (path === projectDir ? ['one.jsonl'] : []))
    hooks.readLines.mockImplementation(async function* () {
      yield JSON.stringify({ type: 'user', sessionId: 'new-entry' })
    })
    const events: string[] = []
    let enter!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => (enter = resolve))
    const gate = new Promise<void>(resolve => (release = resolve))
    const onDelta = vi.fn(() =>
      ownedPendingDelta(
        gate,
        () => {
          events.push('delta-start')
          enter()
        },
        () => {
          events.push('stop')
          release()
          throw stopError
        },
        () => events.push('delta-settled'),
      ),
    )
    const stopError = new Error('Claude stop callback failed')
    const fiber = Effect.runFork(withParserServices(parseAllSessionsEffect(undefined, undefined, onDelta)))
    await started
    expect(cache.providers.claude!.files[filePath]).not.toBe(originalEntry)
    expect(originalEntry).toEqual(originalValue)

    await Effect.runPromise(Fiber.interrupt(fiber))
    const exit = await Effect.runPromise(Fiber.await(fiber))

    expect(events).toEqual(['delta-start', 'stop', 'delta-settled'])
    expect(onDelta).toHaveBeenCalledOnce()
    expect(cache.providers.claude!.files[filePath]).toBe(originalEntry)
    expect(originalEntry).toEqual(originalValue)
    expect(exit._tag === 'Failure' ? Cause.findDefect(exit.cause) : undefined).toMatchObject({
      _tag: 'Success',
      success: stopError,
    })
    expect(hooks.saveCache).not.toHaveBeenCalled()
  })

  it('normalizes a provider factory failure during stop to the scan cancellation error', async () => {
    const path = '/test/one.session'
    const cache = makeCache('test-provider', [path])
    hooks.cache = cache
    hooks.discovered.mockResolvedValue([source('test-provider', path)])
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    hooks.getProvider.mockImplementation(async () => {
      controller.abort(abort)
      throw new Error('provider load failed during stop')
    })

    await expect(
      runParseAllSessionsForTest(undefined, undefined, undefined, undefined, controller.signal),
    ).rejects.toBe(abort)
    expect(cache.providers['test-provider']?.files[path]).toEqual(priorFile)
    expect(hooks.saveCache).not.toHaveBeenCalled()
  })

  it('forwards the same scan context to discovery and provider factories', async () => {
    const path = '/test/context.session'
    hooks.cache = makeCache('test-provider', [path])
    hooks.discovered.mockResolvedValue([source('test-provider', path)])
    hooks.fingerprint.mockResolvedValue({ dev: 2, ino: 2, mtimeMs: 2, sizeBytes: 2 })
    const factory = vi.fn<Provider['createSessionParser']>(() => ({
      parse: async function* () {
        yield parsedCall()
      },
      parseStream: () => Stream.make(parsedCall()),
    }))
    hooks.getProvider.mockResolvedValue({
      network: false,
      durableSources: false,
      discoverSessionsEffect: () => Effect.succeed([]),
      createSessionParser: factory,
    })
    const controller = new AbortController()
    const pricing = captureScanPricing()
    const services = { gatewayEnabled: true, fetchGatewayReport: vi.fn(() => Effect.succeed([])), pricing }
    const onDelta = vi.fn()

    await runParseAllSessionsForTest(undefined, undefined, onDelta, undefined, controller.signal, services)

    const context = hooks.discovered.mock.calls[0][2]
    expect(context).toEqual({ ...services, signal: controller.signal })
    expect(context.fetchGatewayReport).toBe(services.fetchGatewayReport)
    expect(factory).toHaveBeenCalledOnce()
    expect(factory.mock.calls[0][3]).toBe(context)
    expect(context.pricing).toBe(pricing)
    expect(onDelta).toHaveBeenCalledOnce()
    expect(onDelta.mock.calls[0][1]).toBe(pricing)
  })

  it('uses the native stream at parseAllSessionsEffect and preserves schema skip tallies', async () => {
    const path = '/test/native-stream.session'
    const cache = makeCache('test-provider', [path])
    hooks.cache = cache
    hooks.discovered.mockResolvedValue([source('test-provider', path)])
    hooks.fingerprint.mockResolvedValue({ dev: 2, ino: 2, mtimeMs: 2, sizeBytes: 2 })
    const parseStream = vi.fn(() => Stream.fromIterable([{}, parsedCall()] as never[]))
    const parse = vi.fn(async function* () {
      yield* []
      throw new Error('legacy parser should not be selected')
    })
    hooks.getProvider.mockResolvedValue({
      network: false,
      durableSources: false,
      createSessionParser: () => ({ parse, parseStream }),
    })
    const onUnparsed = vi.fn()

    await Effect.runPromise(withParserServices(parseAllSessionsEffect(undefined, undefined, undefined, onUnparsed)))

    expect(parseStream).toHaveBeenCalledOnce()
    expect(parse).not.toHaveBeenCalled()
    expect(onUnparsed).toHaveBeenCalledWith('test-provider', 1)
    expect(cache.providers['test-provider']?.files[path]?.failed).toBeUndefined()
    expect(cache.providers['test-provider']?.files[path]?.turns).toHaveLength(1)
  })

  it('combines native decoder rejections with canonical schema rejections once per source', async () => {
    const path = '/test/native-rejections.session'
    const cache = makeCache('test-provider', [path])
    hooks.cache = cache
    hooks.discovered.mockResolvedValue([source('test-provider', path)])
    hooks.fingerprint.mockResolvedValue({ dev: 2, ino: 2, mtimeMs: 2, sizeBytes: 2 })
    const parse = vi.fn(async function* () {
      yield parsedCall()
    })
    const parseStream = vi.fn((onUnparsedCall: Effect.Effect<void> = Effect.void) =>
      Stream.fromEffect(Effect.andThen(onUnparsedCall, onUnparsedCall)).pipe(
        Stream.flatMap(() => Stream.fromIterable([{ ...parsedCall(), costUSD: NaN }, parsedCall()])),
      ),
    )
    hooks.getProvider.mockResolvedValue({
      network: false,
      durableSources: false,
      createSessionParser: () => ({ parse, parseStream }),
    })
    const onUnparsed = vi.fn()

    await Effect.runPromise(withParserServices(parseAllSessionsEffect(undefined, undefined, undefined, onUnparsed)))

    expect(parseStream).toHaveBeenCalledOnce()
    expect(parse).not.toHaveBeenCalled()
    expect(onUnparsed).toHaveBeenCalledExactlyOnceWith('test-provider', 3)
    expect(cache.providers['test-provider']?.files[path]?.failed).toBeUndefined()
    expect(cache.providers['test-provider']?.files[path]?.turns).toHaveLength(1)
  })

  it.each(['SQLITE_BUSY', 'SQLITE_LOCKED'])('does not cache a wrapped native %s failure', async code => {
    const path = '/test/native-contention.session'
    const cache = makeCache('test-provider', [])
    hooks.cache = cache
    hooks.discovered.mockResolvedValue([source('test-provider', path)])
    hooks.fingerprint.mockResolvedValue({ dev: 2, ino: 2, mtimeMs: 2, sizeBytes: 2 })
    const native = Object.assign(new Error('read unavailable'), { code })
    const error = new Error('provider read failed', { cause: native })
    const parse = vi.fn(async function* () {})
    const parseStream = vi.fn(() => Stream.fail(error))
    hooks.getProvider.mockResolvedValue({
      network: false,
      durableSources: false,
      createSessionParser: () => ({ parse, parseStream }),
    })

    await Effect.runPromise(withParserServices(parseAllSessionsEffect()))

    expect(parseStream).toHaveBeenCalledOnce()
    expect(parse).not.toHaveBeenCalled()
    expect(cache.providers['test-provider']?.files[path]).toBeUndefined()
  })

  it('records a native stream failure as a fingerprinted per-file failure marker', async () => {
    const path = '/test/native-stream-failure.session'
    const cache = makeCache('test-provider', [path])
    hooks.cache = cache
    hooks.discovered.mockResolvedValue([source('test-provider', path)])
    hooks.fingerprint.mockResolvedValue({ dev: 2, ino: 2, mtimeMs: 2, sizeBytes: 2 })
    hooks.getProvider.mockResolvedValue({
      network: false,
      durableSources: false,
      createSessionParser: () => ({
        parse: async function* () {},
        parseStream: () => Stream.fail(new Error('bad source')),
      }),
    })

    await Effect.runPromise(withParserServices(parseAllSessionsEffect()))

    expect(cache.providers['test-provider']?.files[path]).toMatchObject({
      fingerprint: { dev: 2, ino: 2, mtimeMs: 2, sizeBytes: 2 },
      turns: [],
      failed: true,
    })
  })

  it('keeps durable cache merges and re-emits durable orphans through the native provider path', async () => {
    const path = '/test/durable.session'
    const orphanPath = '/test/pruned.session'
    const cache = makeCache('test-provider', [path, orphanPath])
    const timestamp = new Date().toISOString()
    const durableTurn = (deduplicationKey: string) => ({
      timestamp,
      sessionId: 'session-1',
      userMessage: 'cached',
      calls: [
        {
          provider: 'test-provider',
          model: 'test-model',
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationInputTokens: 0,
            cacheReadInputTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            webSearchRequests: 0,
            cacheCreationOneHourTokens: 0,
          },
          speed: 'standard' as const,
          timestamp,
          tools: [],
          bashCommands: [],
          skills: [],
          deduplicationKey,
          project: 'test-project',
        },
      ],
    })
    cache.providers['test-provider']!.durable = true
    cache.providers['test-provider']!.files[path]!.turns = [durableTurn('cached-call')]
    cache.providers['test-provider']!.files[orphanPath]!.turns = [durableTurn('orphan-call')]
    hooks.cache = cache
    hooks.discovered.mockResolvedValue([source('test-provider', path)])
    hooks.fingerprint.mockResolvedValue({ dev: 2, ino: 2, mtimeMs: 2, sizeBytes: 2 })
    hooks.getProvider.mockResolvedValue({
      network: false,
      durableSources: true,
      createSessionParser: () => ({
        parse: async function* () {
          yield parsedCall()
        },
        parseStream: () => Stream.make(parsedCall()),
      }),
    })
    const onDelta = vi.fn(() => Effect.void)

    await Effect.runPromise(withParserServices(parseAllSessionsEffect(undefined, undefined, onDelta)))

    expect(cache.providers['test-provider']?.files[path]?.turns.map(turn => turn.calls[0]?.deduplicationKey)).toEqual([
      'cached-call',
      'test-provider:call-1',
    ])
    expect(onDelta).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'test-provider', filePath: orphanPath, verdict: 'appended', durable: true }),
      expect.anything(),
    )
  })

  it('ages out durable cache entries using the Effect Clock before orphan re-emission', async () => {
    const nowMs = Date.parse('2026-10-14T12:00:00.000Z')
    const oldTimestamp = new Date(nowMs - 91 * 24 * 60 * 60 * 1000).toISOString()
    const freshTimestamp = new Date(nowMs - 1_000).toISOString()
    const path = '/test/durable-current.session'
    const orphanPath = '/test/durable-aged-orphan.session'
    const cache = makeCache('test-provider', [path, orphanPath])
    const section = cache.providers['test-provider']
    if (!section) throw new Error('test provider cache section was not created')
    section.durable = true
    const orphan = section.files[orphanPath]
    if (!orphan) throw new Error('durable orphan cache entry was not created')
    orphan.turns = [
      {
        timestamp: oldTimestamp,
        sessionId: 'session-1',
        userMessage: 'old cached usage',
        calls: [
          {
            provider: 'test-provider',
            model: 'test-model',
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              cacheCreationInputTokens: 0,
              cacheReadInputTokens: 0,
              cachedInputTokens: 0,
              reasoningTokens: 0,
              webSearchRequests: 0,
              cacheCreationOneHourTokens: 0,
            },
            speed: 'standard',
            timestamp: oldTimestamp,
            tools: [],
            bashCommands: [],
            skills: [],
            deduplicationKey: 'aged-orphan-call',
            project: 'test-project',
          },
        ],
      },
    ]
    hooks.cache = cache
    hooks.discovered.mockResolvedValue([source('test-provider', path)])
    hooks.fingerprint.mockResolvedValue({ dev: 2, ino: 2, mtimeMs: 2, sizeBytes: 2 })
    hooks.getProvider.mockResolvedValue({
      network: false,
      durableSources: true,
      createSessionParser: () => ({
        parse: async function* () {
          yield { ...parsedCall(), timestamp: freshTimestamp }
        },
        parseStream: () => Stream.make({ ...parsedCall(), timestamp: freshTimestamp }),
      }),
    })
    const onDelta = vi.fn(() => Effect.void)

    await Effect.runPromise(
      withParserServices(
        Effect.gen(function* () {
          yield* TestClock.setTime(nowMs)
          return yield* parseAllSessionsEffect(undefined, undefined, onDelta)
        }).pipe(Effect.provide(TestClock.layer())),
      ),
    )

    expect(section.files[orphanPath]).toBeUndefined()
    expect(onDelta).not.toHaveBeenCalledWith(
      expect.objectContaining({ filePath: orphanPath, durable: true }),
      expect.anything(),
    )
  })

  it('restores the original durable cache entry when interrupted during delta publication', async () => {
    const path = '/test/durable-delta-cancel.session'
    const cache = makeCache('test-provider', [path])
    const section = cache.providers['test-provider']!
    section.durable = true
    const originalEntry = section.files[path]!
    const originalValue = structuredClone(originalEntry)
    hooks.cache = cache
    hooks.discovered.mockResolvedValue([source('test-provider', path)])
    hooks.fingerprint.mockResolvedValue({ dev: 2, ino: 2, mtimeMs: 2, sizeBytes: 2 })
    hooks.getProvider.mockResolvedValue({
      network: false,
      durableSources: true,
      createSessionParser: () => ({
        parse: async function* () {
          yield parsedCall()
        },
        parseStream: () => Stream.make(parsedCall()),
      }),
    })
    let finishDelta!: () => void
    const pendingDelta = new Promise<void>(resolve => {
      finishDelta = resolve
    })
    let startDelta!: () => void
    const deltaStarted = new Promise<void>(resolve => {
      startDelta = resolve
    })
    const stop = vi.fn(() => finishDelta())
    const onDelta = vi.fn(() => ownedPendingDelta(pendingDelta, startDelta, stop, () => undefined))
    const fiber = Effect.runFork(withParserServices(parseAllSessionsEffect(undefined, undefined, onDelta)))
    await deltaStarted
    expect(section.files[path]?.turns).toHaveLength(1)
    expect(section.files[path]?.fingerprint.mtimeMs).toBe(2)
    expect(originalEntry).toEqual(originalValue)

    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(stop).toHaveBeenCalledOnce()
    expect(section.files[path]).toBe(originalEntry)
    expect(section.files[path]).toEqual(originalValue)
    expect(hooks.saveCache).not.toHaveBeenCalled()
  })

  it('drains pending native parser IO before releasing its stream when interrupted', async () => {
    const path = '/test/pending-native.session'
    const cache = makeCache('test-provider', [path])
    hooks.cache = cache
    hooks.discovered.mockResolvedValue([source('test-provider', path)])
    hooks.fingerprint.mockResolvedValue({ dev: 2, ino: 2, mtimeMs: 2, sizeBytes: 2 })
    const events: string[] = []
    let finishRead!: (call: ReturnType<typeof parsedCall>) => void
    let signalStarted!: () => void
    const started = new Promise<void>(resolve => (signalStarted = resolve))
    const pendingRead = new Promise<ReturnType<typeof parsedCall>>(resolve => {
      finishRead = resolve
    })
    const stopError = new Error('stop callback failed')
    const stop = vi.fn(() => {
      events.push('stop')
      finishRead(parsedCall())
      throw stopError
    })
    const parseStream = () =>
      Stream.fromEffect(
        Effect.acquireUseRelease(
          Effect.sync(() => {
            events.push('next-start')
            signalStarted()
            return pendingRead
          }),
          pending =>
            Effect.tryPromise({
              try: () => pending,
              catch: cause => (cause instanceof Error ? cause : new Error(String(cause))),
            }),
          pending =>
            Effect.sync(() => stop()).pipe(
              Effect.ensuring(
                Effect.promise(() =>
                  pending.then(
                    () => {
                      events.push('next-settled')
                    },
                    () => {
                      events.push('next-settled')
                    },
                  ),
                ).pipe(Effect.andThen(Effect.sync(() => events.push('stream-release')))),
              ),
            ),
        ),
      )
    hooks.getProvider.mockResolvedValue({
      network: false,
      durableSources: false,
      createSessionParser: () => ({
        parse: async function* () {
          yield parsedCall()
        },
        parseStream,
      }),
    })
    const controller = new AbortController()
    let interruptedExit!: import('effect/Exit').Exit<unknown, unknown>
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(
          withParserServices(
            parseAllSessionsEffect(undefined, undefined, undefined, undefined, controller.signal, {}, stop),
          ),
        )
        yield* Effect.promise(() => started)
        yield* Fiber.interrupt(fiber)
        interruptedExit = yield* Fiber.await(fiber)
      }),
    )

    expect(events).toEqual(['next-start', 'stop', 'next-settled', 'stream-release'])
    expect(cache.providers['test-provider']?.files[path]).toEqual(priorFile)
    expect(interruptedExit._tag).toBe('Failure')
    expect(interruptedExit._tag === 'Failure' ? Cause.findDefect(interruptedExit.cause) : undefined).toMatchObject({
      _tag: 'Success',
      success: stopError,
    })
  })
})
