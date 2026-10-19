import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { Cause, Effect, Exit, Fiber, FileSystem, PlatformError, Stream } from 'effect'
import * as Scope from 'effect/Scope'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  statCalls: 0,
  readCalls: 0,
  streamOpens: 0,
  streamCloses: 0,
  blockCacheRead: false,
  releaseCacheRead: undefined as (() => void) | undefined,
  pauseNextStream: false,
  onStreamStarted: undefined as (() => void) | undefined,
  onStreamClosed: undefined as (() => void) | undefined,
  onCacheReadStarted: undefined as (() => void) | undefined,
  blockFlushWrite: false,
  blockFlushOpen: false,
  failNextFlushClose: false,
  dieNextFlushClose: false,
  compoundFlushClose: false,
  failNextFlushWrite: false,
  dieNextFlushWrite: false,
  flushTempPath: undefined as string | undefined,
  flushFile: undefined as FileSystem.File | undefined,
  closedBeforeRename: false,
  flushHandleCloses: 0,
  onFlushOpenStarted: undefined as (() => void) | undefined,
  releaseFlushOpen: undefined as (() => void) | undefined,
  onFlushWriteStarted: undefined as (() => void) | undefined,
  releaseFlushWrite: undefined as (() => void) | undefined,
}))

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) => {
      const stream = actual.createReadStream(...args)
      hooks.streamOpens++
      stream.once('close', () => {
        hooks.streamCloses++
        hooks.onStreamClosed?.()
      })
      if (hooks.pauseNextStream) {
        hooks.pauseNextStream = false
        stream.once('data', () => {
          stream.pause()
          hooks.onStreamStarted?.()
        })
      }
      return stream
    },
  }
})

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: (...args: Parameters<typeof actual.stat>) => {
      hooks.statCalls++
      return actual.stat(...args)
    },
  }
})

import { writeFile } from 'node:fs/promises'

import { appPaths, Env, initAppPaths } from '../src/main/env.js'
import { flushCodexCacheEffect, lookupCachedCodexResultsEffect } from '../src/main/pipeline/codex-cache.js'
import { createCodexProvider } from '../src/main/pipeline/providers/codex.js'
import type { ProviderScanContext, SessionParser } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import { discoverProviderSessions } from './fixtures/provider-effects.js'

let root = ''
let priorCacheDir = ''

function fileSystemError(method: string, message: string): PlatformError.PlatformError {
  return PlatformError.systemError({ _tag: 'Unknown', module: 'FileSystem', method, cause: new Error(message) })
}

function observedFileSystem(fs: FileSystem.FileSystem): FileSystem.FileSystem {
  return {
    ...fs,
    readFileString: (path, encoding) => {
      if (!path.endsWith('codex-results.json')) return fs.readFileString(path, encoding)
      hooks.readCalls++
      if (!hooks.blockCacheRead) return fs.readFileString(path, encoding)
      hooks.onCacheReadStarted?.()
      return Effect.uninterruptible(
        Effect.promise(
          () =>
            new Promise<void>(resolve => {
              hooks.releaseCacheRead = resolve
            }),
        ),
      ).pipe(Effect.flatMap(() => fs.readFileString(path, encoding)))
    },
    open: (path, options) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const scope = yield* Effect.scope
          const temporary = path.endsWith('.tmp')
          if (temporary) {
            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => {
                hooks.flushHandleCloses++
                if (hooks.failNextFlushClose) {
                  hooks.failNextFlushClose = false
                  throw fileSystemError('open', 'close failed')
                }
                if (hooks.dieNextFlushClose) {
                  hooks.dieNextFlushClose = false
                  throw new Error('arbitrary close defect')
                }
              }),
            )
            if (hooks.compoundFlushClose) {
              hooks.compoundFlushClose = false
              yield* Scope.addFinalizer(
                scope,
                Effect.sync(() => {
                  throw new Error('arbitrary compound close defect')
                }),
              )
              yield* Scope.addFinalizer(
                scope,
                Effect.sync(() => {
                  throw fileSystemError('open', 'platform compound close defect')
                }),
              )
            }
          }
          const handle = yield* Effect.uninterruptible(fs.open(path, options))
          if (!temporary) return handle
          hooks.flushTempPath = path
          hooks.flushFile = handle
          if (hooks.blockFlushOpen) {
            hooks.blockFlushOpen = false
            yield* Effect.uninterruptible(
              Effect.promise(
                () =>
                  new Promise<void>(resolve => {
                    hooks.releaseFlushOpen = resolve
                    hooks.onFlushOpenStarted?.()
                  }),
              ),
            )
          }
          return {
            ...handle,
            sync: handle.sync,
            writeAll: bytes => {
              if (hooks.dieNextFlushWrite) {
                hooks.dieNextFlushWrite = false
                return Effect.die(fileSystemError('write', 'write defect'))
              }
              if (hooks.failNextFlushWrite) {
                hooks.failNextFlushWrite = false
                return Effect.fail(fileSystemError('write', 'write failed'))
              }
              if (!hooks.blockFlushWrite) return handle.writeAll(bytes)
              return Effect.uninterruptible(
                Effect.promise(
                  () =>
                    new Promise<void>(resolve => {
                      hooks.releaseFlushWrite = resolve
                      hooks.onFlushWriteStarted?.()
                    }),
                ),
              ).pipe(Effect.flatMap(() => handle.writeAll(bytes)))
            },
          }
        }),
      ),
    rename: (fromPath, toPath) =>
      Effect.gen(function* () {
        if (hooks.flushFile) {
          const stat = yield* Effect.exit(hooks.flushFile.stat)
          if (Exit.isFailure(stat)) {
            const failure = Cause.findErrorOption(stat.cause)
            const cause =
              failure._tag === 'Some' && PlatformError.isPlatformError(failure.value) ? failure.value.cause : null
            hooks.closedBeforeRename = (cause as NodeJS.ErrnoException | null)?.code === 'EBADF'
          }
        }
        yield* fs.rename(fromPath, toPath)
      }),
  }
}

function withCacheFileSystem<A, E, R extends FileSystem.FileSystem>(effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* Effect.provideService(effect, FileSystem.FileSystem, observedFileSystem(fs))
  }).pipe(Effect.provide(NodeFileSystem.layer))
}

function runWithCacheFileSystem<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>) {
  return Effect.runPromise(withCacheFileSystem(effect))
}

function providerParserIterator(parser: SessionParser<FileSystem.FileSystem>) {
  return (async function* () {
    const fs = observedFileSystem(
      await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer))),
    )
    const stream = parser.parseStream()
    if (!stream) return
    yield* Stream.toAsyncIterable(stream.pipe(Stream.provideService(FileSystem.FileSystem, fs)))
  })()
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'watchtower-codex-stop-'))
  priorCacheDir = appPaths().cacheDir
  initAppPaths({ cacheDir: join(root, 'cache') })
  hooks.statCalls = 0
  hooks.readCalls = 0
  hooks.streamOpens = 0
  hooks.streamCloses = 0
  hooks.blockCacheRead = false
  hooks.releaseCacheRead = undefined
  hooks.pauseNextStream = false
  hooks.onStreamStarted = undefined
  hooks.onStreamClosed = undefined
  hooks.onCacheReadStarted = undefined
  hooks.blockFlushWrite = false
  hooks.blockFlushOpen = false
  hooks.failNextFlushClose = false
  hooks.dieNextFlushClose = false
  hooks.compoundFlushClose = false
  hooks.failNextFlushWrite = false
  hooks.dieNextFlushWrite = false
  hooks.flushTempPath = undefined
  hooks.flushFile = undefined
  hooks.closedBeforeRename = false
  hooks.flushHandleCloses = 0
  hooks.onFlushOpenStarted = undefined
  hooks.releaseFlushOpen = undefined
  hooks.onFlushWriteStarted = undefined
  hooks.releaseFlushWrite = undefined
})

afterEach(async () => {
  initAppPaths({ cacheDir: priorCacheDir })
  rmSync(root, { recursive: true, force: true })
})

function source(path: string) {
  return { path, project: 'codex-stop-project', provider: 'codex' }
}

async function writeSession(path: string, trailer = ''): Promise<void> {
  await writeFile(
    path,
    [
      JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-10-01T00:00:00.000Z',
        payload: { session_id: 'stop-session', cwd: '/project', originator: 'Codex' },
      }),
      JSON.stringify({
        type: 'event_msg',
        timestamp: '2026-10-01T00:00:01.000Z',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 10,
              cached_input_tokens: 2,
              output_tokens: 5,
              reasoning_output_tokens: 1,
            },
            total_token_usage: {
              total_tokens: 18,
              input_tokens: 10,
              cached_input_tokens: 2,
              output_tokens: 5,
              reasoning_output_tokens: 1,
            },
          },
        },
      }),
      trailer,
    ].join('\n'),
  )
}

function parse(path: string, seenKeys = new Set<string>(), context?: ProviderScanContext) {
  return providerParserIterator(
    createCodexProvider('/unused').createSessionParser(source(path), seenKeys, undefined, context),
  )
}

function flush(signal?: AbortSignal): Promise<void> {
  return runWithCacheFileSystem(Effect.scoped(flushCodexCacheEffect(signal)))
}

async function expectClosedFlushFile(): Promise<void> {
  const file = hooks.flushFile
  expect(file).toBeDefined()
  if (!file) return
  const result = await Effect.runPromise(Effect.exit(file.stat))
  expect(Exit.isFailure(result)).toBe(true)
  if (Exit.isFailure(result)) {
    const failure = Cause.findErrorOption(result.cause)
    const cause = failure._tag === 'Some' && PlatformError.isPlatformError(failure.value) ? failure.value.cause : null
    expect((cause as NodeJS.ErrnoException | null)?.code).toBe('EBADF')
  }
}

describe('Codex scan cancellation', () => {
  it('preserves the typed scan abort when a native cache read is cancelled without an explicit reason', async () => {
    const path = join(root, 'native-cache-abort.jsonl')
    await writeFile(path, '')
    hooks.blockCacheRead = true
    const started = new Promise<void>(resolve => {
      hooks.onCacheReadStarted = resolve
    })
    const controller = new AbortController()
    const parser = createCodexProvider('/unused').createSessionParser(source(path), new Set(), undefined, {
      signal: controller.signal,
    })
    if (!parser.parseStream) throw new Error('Codex must provide a native parser stream')
    const result = runWithCacheFileSystem(Stream.runCollect(parser.parseStream()))
    const rejected = expect(result).rejects.toMatchObject({ _tag: 'ScanAbortedError', message: 'scan aborted' })
    await started
    controller.abort()
    hooks.releaseCacheRead?.()
    await rejected
    expect(hooks.streamOpens).toBe(0)
  })

  it('passes cancellation to cache loading and does not memoize a cancelled empty cache', async () => {
    const path = join(root, 'cache-read-source.jsonl')
    await writeFile(path, '')
    hooks.blockCacheRead = true
    let start!: () => void
    const started = new Promise<void>(resolve => {
      start = resolve
    })
    hooks.onCacheReadStarted = start
    const controller = new AbortController()

    const pending = runWithCacheFileSystem(
      Effect.scoped(lookupCachedCodexResultsEffect(path, controller.signal).pipe(Effect.map(value => value.calls))),
    )
    await started
    controller.abort(new ScanAbortedError({ message: 'scan aborted' }))
    hooks.releaseCacheRead?.()
    await expect(pending).rejects.toMatchObject({ _tag: 'ScanAbortedError' })

    hooks.blockCacheRead = false
    await expect(
      runWithCacheFileSystem(
        Effect.scoped(lookupCachedCodexResultsEffect(path, undefined).pipe(Effect.map(x => x.calls))),
      ),
    ).resolves.toBeNull()
    expect(hooks.readCalls).toBe(2)
  })

  it('closes the bounded discovery header stream when its scan is stopped', async () => {
    const codexHome = join(root, 'codex-home')
    const sessionDir = join(codexHome, 'sessions', '2026', '10', '05')
    const path = join(sessionDir, 'rollout-header.jsonl')
    await (await import('node:fs/promises')).mkdir(sessionDir, { recursive: true })
    await writeFile(
      path,
      `${JSON.stringify({ type: 'session_meta', payload: { originator: 'Codex', cwd: '/project' } })}${'x'.repeat(2 * 1024 * 1024)}`,
    )
    hooks.pauseNextStream = true

    let start!: () => void
    const started = new Promise<void>(resolve => {
      start = resolve
    })
    let close!: () => void
    const closed = new Promise<void>(resolve => {
      close = resolve
    })
    hooks.onStreamStarted = start
    hooks.onStreamClosed = close

    const controller = new AbortController()
    const pending = discoverProviderSessions(createCodexProvider(codexHome), { signal: controller.signal })
    await started
    controller.abort(new ScanAbortedError({ message: 'scan aborted' }))

    await expect(pending).rejects.toMatchObject({ _tag: 'ScanAbortedError' })
    expect(hooks.streamCloses).toBe(1)
    await closed
    expect(hooks.streamCloses).toBe(1)
  })

  it('drains the bounded discovery header reader when its native Effect fiber is interrupted', async () => {
    const codexHome = join(root, 'codex-home-effect-interrupt')
    const sessionDir = join(codexHome, 'sessions', '2026', '10', '05')
    const path = join(sessionDir, 'rollout-header.jsonl')
    await (await import('node:fs/promises')).mkdir(sessionDir, { recursive: true })
    await writeFile(
      path,
      `${JSON.stringify({ type: 'session_meta', payload: { originator: 'Codex', cwd: '/project' } })}${'x'.repeat(2 * 1024 * 1024)}`,
    )
    hooks.pauseNextStream = true

    let start!: () => void
    const started = new Promise<void>(resolve => {
      start = resolve
    })
    let close!: () => void
    const closed = new Promise<void>(resolve => {
      close = resolve
    })
    hooks.onStreamStarted = start
    hooks.onStreamClosed = close

    const discover = createCodexProvider(codexHome).discoverSessionsEffect
    if (!discover) throw new Error('Codex Effect discovery is unavailable')
    const fiber = Effect.runFork(withCacheFileSystem(discover().pipe(Effect.provide(Env.layer))))
    await started
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(hooks.streamOpens).toBe(1)
    expect(hooks.streamCloses).toBe(1)
    await closed
    expect(hooks.streamCloses).toBe(1)
  })

  it('stops an active native session stream, drains it, and skips cache publication', async () => {
    const path = join(root, 'rollout-stop.jsonl')
    await writeSession(path, 'x'.repeat(2 * 1024 * 1024))
    hooks.pauseNextStream = true

    let start!: () => void
    const started = new Promise<void>(resolve => {
      start = resolve
    })
    let close!: () => void
    const closed = new Promise<void>(resolve => {
      close = resolve
    })
    hooks.onStreamStarted = start
    hooks.onStreamClosed = close

    const controller = new AbortController()
    const seenKeys = new Set<string>()
    const parser = parse(path, seenKeys, { signal: controller.signal })
    const pending = parser.next()
    await started
    controller.abort(new ScanAbortedError({ message: 'scan aborted' }))

    await expect(pending).rejects.toMatchObject({ _tag: 'ScanAbortedError', message: 'scan aborted' })
    expect(hooks.streamCloses).toBe(1)
    await closed
    expect(hooks.streamOpens).toBe(1)
    expect(hooks.streamCloses).toBe(1)
    expect(seenKeys).toEqual(new Set())
    await expect(parser.next()).resolves.toMatchObject({ done: true })

    await flush()
    const { readFile: readCache } = await import('node:fs/promises')
    const cache = JSON.parse(await readCache(join(root, 'cache', 'codex-results.json'), 'utf-8')) as {
      files: Record<string, unknown>
    }
    expect(cache.files[path]).toBeUndefined()
  })

  it('does no cache or source IO for a pre-aborted parser', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    controller.abort(abort)
    const before = { stats: hooks.statCalls, reads: hooks.readCalls, streams: hooks.streamOpens }
    const seenKeys = new Set<string>()

    await expect(parse(join(root, 'never-read.jsonl'), seenKeys, { signal: controller.signal }).next()).rejects.toBe(
      abort,
    )
    expect({ stats: hooks.statCalls, reads: hooks.readCalls, streams: hooks.streamOpens }).toEqual(before)
    expect(seenKeys).toEqual(new Set())
  })

  it('uses cached calls without opening the session stream on a warm parse', async () => {
    const path = join(root, 'rollout-cached.jsonl')
    await writeSession(path)
    const first = parse(path)
    const calls = []
    for await (const call of first) calls.push(call)
    await flush()
    const streamOpens = hooks.streamOpens

    const seenKeys = new Set<string>()
    const cached = parse(path, seenKeys)
    const cachedCalls = []
    for await (const call of cached) cachedCalls.push(call)

    expect(cachedCalls).toEqual(calls)
    expect(hooks.streamOpens).toBe(streamOpens)
    expect(seenKeys).toEqual(new Set(calls.map(call => call.deduplicationKey)))
    expect(hooks.closedBeforeRename).toBe(true)
  })

  it('removes the second cache fingerprint stat from a cold parser request', async () => {
    const path = join(root, 'single-stat-lookup.jsonl')
    await writeSession(path)
    hooks.statCalls = 0

    const calls = []
    for await (const call of parse(path)) calls.push(call)

    expect(calls).toHaveLength(1)
    // One stat is owned by the session-line reader; the cache lookup supplies
    // the parser fingerprint without its former second stat.
    expect(hooks.statCalls).toBe(2)
  })

  it('cancels a staged cache flush without replacing disk or evicting memory entries', async () => {
    const cachedPath = join(root, 'rollout-flush-cached.jsonl')
    const pendingPath = join(root, 'rollout-flush-pending.jsonl')
    await writeSession(cachedPath)
    await writeSession(pendingPath)

    const initial = parse(cachedPath)
    const initialCalls = []
    for await (const call of initial) initialCalls.push(call)
    await flush()

    const cachePath = join(root, 'cache', 'codex-results.json')
    const oldContents = await (await import('node:fs/promises')).readFile(cachePath)
    hooks.flushHandleCloses = 0
    const pending = parse(pendingPath)
    const pendingCalls = []
    for await (const call of pending) pendingCalls.push(call)

    hooks.blockFlushWrite = true
    hooks.failNextFlushClose = true
    let start!: () => void
    const started = new Promise<void>(resolve => {
      start = resolve
    })
    hooks.onFlushWriteStarted = start
    const controller = new AbortController()
    const flushing = flush(controller.signal)
    let tempPath: string | undefined
    try {
      await started
      tempPath = hooks.flushTempPath
      if (!tempPath) throw new Error('Cache flush did not create its temporary file')
    } finally {
      controller.abort(new ScanAbortedError({ message: 'scan aborted' }))
      hooks.releaseFlushWrite?.()
    }
    await expect(flushing).rejects.toMatchObject({ _tag: 'ScanAbortedError' })

    await expectClosedFlushFile()
    expect(tempPath).toBeDefined()
    expect(existsSync(tempPath ?? '')).toBe(false)
    await expect((await import('node:fs/promises')).readFile(cachePath)).resolves.toEqual(oldContents)
    await expect(
      runWithCacheFileSystem(
        Effect.scoped(lookupCachedCodexResultsEffect(cachedPath, undefined).pipe(Effect.map(x => x.calls))),
      ),
    ).resolves.toEqual(initialCalls)
    await expect(
      runWithCacheFileSystem(
        Effect.scoped(lookupCachedCodexResultsEffect(pendingPath, undefined).pipe(Effect.map(x => x.calls))),
      ),
    ).resolves.toEqual(pendingCalls)
  })

  it('closes an opened cache handle when interrupted during open acquisition', async () => {
    const cachedPath = join(root, 'rollout-open-cached.jsonl')
    const pendingPath = join(root, 'rollout-open-pending.jsonl')
    await writeSession(cachedPath)
    await writeSession(pendingPath)

    const initialCalls = []
    for await (const call of parse(cachedPath)) initialCalls.push(call)
    await flush()
    const cachePath = join(root, 'cache', 'codex-results.json')
    const oldContents = await (await import('node:fs/promises')).readFile(cachePath)
    hooks.flushHandleCloses = 0
    const pendingCalls = []
    for await (const call of parse(pendingPath)) pendingCalls.push(call)

    hooks.blockFlushOpen = true
    let start!: () => void
    const started = new Promise<void>(resolve => {
      start = resolve
    })
    hooks.onFlushOpenStarted = start
    const fiber = Effect.runFork(withCacheFileSystem(Effect.scoped(flushCodexCacheEffect(undefined))))
    await started

    const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
    hooks.releaseFlushOpen?.()
    await interrupted

    await expectClosedFlushFile()
    expect(hooks.flushTempPath).toBeDefined()
    expect(existsSync(hooks.flushTempPath ?? '')).toBe(false)
    await expect((await import('node:fs/promises')).readFile(cachePath)).resolves.toEqual(oldContents)
    await expect(
      runWithCacheFileSystem(
        Effect.scoped(lookupCachedCodexResultsEffect(cachedPath, undefined).pipe(Effect.map(x => x.calls))),
      ),
    ).resolves.toEqual(initialCalls)
    await expect(
      runWithCacheFileSystem(
        Effect.scoped(lookupCachedCodexResultsEffect(pendingPath, undefined).pipe(Effect.map(x => x.calls))),
      ),
    ).resolves.toEqual(pendingCalls)
  })

  it('does not replace the published cache when closing the staged handle fails', async () => {
    const cachedPath = join(root, 'rollout-close-cached.jsonl')
    const pendingPath = join(root, 'rollout-close-pending.jsonl')
    await writeSession(cachedPath)
    await writeSession(pendingPath)
    for await (const _call of parse(cachedPath)) {
      /* Populate the existing disk cache. */
    }
    await flush()
    const cachePath = join(root, 'cache', 'codex-results.json')
    const oldContents = await (await import('node:fs/promises')).readFile(cachePath)
    hooks.flushHandleCloses = 0
    const pendingCalls = []
    for await (const call of parse(pendingPath)) pendingCalls.push(call)

    hooks.failNextFlushClose = true
    await flush()

    await expectClosedFlushFile()
    expect(hooks.flushTempPath).toBeDefined()
    expect(existsSync(hooks.flushTempPath ?? '')).toBe(false)
    await expect((await import('node:fs/promises')).readFile(cachePath)).resolves.toEqual(oldContents)
    await expect(
      runWithCacheFileSystem(lookupCachedCodexResultsEffect(pendingPath).pipe(Effect.map(x => x.calls))),
    ).resolves.toEqual(pendingCalls)
  })

  it('keeps PlatformError defects from the write operation as defects', async () => {
    const cachedPath = join(root, 'rollout-write-defect-cached.jsonl')
    const pendingPath = join(root, 'rollout-write-defect-pending.jsonl')
    await writeSession(cachedPath)
    await writeSession(pendingPath)
    for await (const _call of parse(cachedPath)) {
      /* Populate the existing disk cache. */
    }
    hooks.dieNextFlushWrite = true
    for await (const _call of parse(pendingPath)) {
      /* Queue a cache update. */
    }

    const exit = await runWithCacheFileSystem(Effect.exit(Effect.scoped(flushCodexCacheEffect(undefined))))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const defect = Cause.findDefect(exit.cause)
      expect(defect._tag).toBe('Success')
      if (defect._tag === 'Success') expect(PlatformError.isPlatformError(defect.success)).toBe(true)
    }
  })

  it('preserves an arbitrary close defect when the write operation also fails', async () => {
    const cachedPath = join(root, 'rollout-write-close-defect-cached.jsonl')
    const pendingPath = join(root, 'rollout-write-close-defect-pending.jsonl')
    await writeSession(cachedPath)
    await writeSession(pendingPath)
    for await (const _call of parse(cachedPath)) {
      /* Populate the existing disk cache. */
    }
    hooks.failNextFlushWrite = true
    hooks.dieNextFlushClose = true
    for await (const _call of parse(pendingPath)) {
      /* Queue a cache update. */
    }

    const exit = await runWithCacheFileSystem(Effect.exit(Effect.scoped(flushCodexCacheEffect(undefined))))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons).toHaveLength(2)
      expect(exit.cause.reasons.filter(Cause.isFailReason).map(reason => reason.error)).toContainEqual(
        expect.objectContaining({
          reason: expect.objectContaining({ cause: expect.objectContaining({ message: 'write failed' }) }),
        }),
      )
      expect(
        exit.cause.reasons.some(
          reason =>
            Cause.isDieReason(reason) &&
            reason.defect instanceof Error &&
            reason.defect.message === 'arbitrary close defect',
        ),
      ).toBe(true)
    }
  })

  it('preserves every unexpected finalizer reason when one reason is a PlatformError', async () => {
    const cachedPath = join(root, 'rollout-compound-close-cached.jsonl')
    const pendingPath = join(root, 'rollout-compound-close-pending.jsonl')
    await writeSession(cachedPath)
    await writeSession(pendingPath)
    for await (const _call of parse(cachedPath)) {
      /* Populate the existing disk cache. */
    }
    hooks.compoundFlushClose = true
    for await (const _call of parse(pendingPath)) {
      /* Queue a cache update. */
    }

    const exit = await runWithCacheFileSystem(Effect.exit(Effect.scoped(flushCodexCacheEffect(undefined))))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons).toHaveLength(2)
      expect(
        exit.cause.reasons.some(reason => Cause.isDieReason(reason) && PlatformError.isPlatformError(reason.defect)),
      ).toBe(true)
      expect(
        exit.cause.reasons.some(
          reason =>
            Cause.isDieReason(reason) &&
            reason.defect instanceof Error &&
            reason.defect.message === 'arbitrary compound close defect',
        ),
      ).toBe(true)
    }
  })
})
