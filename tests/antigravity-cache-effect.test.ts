import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { Cause, Effect, Exit, Fiber, FileSystem, Scope, Stream } from 'effect'
import * as PlatformError from 'effect/PlatformError'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  failCacheRead: false,
  failWrite: false,
  failClose: false,
  dieClose: false,
  failRename: false,
  failRandomBytes: false,
  renameCalls: 0,
  pauseWrite: false,
  abortOnWrite: undefined as (() => void) | undefined,
  onWriteStarted: undefined as (() => void) | undefined,
  releaseWrite: undefined as (() => void) | undefined,
  cleanupAfterClose: [] as boolean[],
  closedBeforeRename: [] as boolean[],
}))

function fileSystemError(method: string, message: string): PlatformError.PlatformError {
  return PlatformError.systemError({
    _tag: 'Unknown',
    module: 'FileSystem',
    method,
    cause: new Error(message),
  })
}

vi.mock('crypto', async importOriginal => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return {
    ...actual,
    randomBytes: (...args: Parameters<typeof actual.randomBytes>) => {
      if (hooks.failRandomBytes) throw new Error('crypto defect')
      return actual.randomBytes(...args)
    },
  }
})

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null, stdout: string) => void
      callback(null, '')
      return {} as ReturnType<typeof actual.execFile>
    },
  }
})

let root = ''
let provider: typeof import('../src/main/pipeline/providers/antigravity.js')
let openedTempFiles: FileSystem.File[] = []

function hookedFileSystem(fs: FileSystem.FileSystem): FileSystem.FileSystem {
  return {
    ...fs,
    readFileString: (path, encoding) => {
      if (hooks.failCacheRead && path.endsWith('antigravity-results.json')) {
        return Effect.fail(fileSystemError('readFileString', 'cache read failed'))
      }
      return fs.readFileString(path, encoding)
    },
    open: (path, options) =>
      Effect.gen(function* () {
        const handle = yield* fs.open(path, options)
        if (!path.endsWith('.tmp')) return handle
        openedTempFiles.push(handle)
        const scope = yield* Effect.scope
        const closeFinalizer = Effect.sync(() => hooks.cleanupAfterClose.push(true)).pipe(
          Effect.asVoid,
          Effect.andThen(
            Effect.suspend(() => {
              if (hooks.dieClose) return Effect.die(new Error('close defect'))
              if (hooks.failClose) return Effect.die(fileSystemError('close', 'cache close failed'))
              return Effect.void
            }),
          ),
        )
        yield* Scope.addFinalizer(scope, closeFinalizer)
        return {
          ...handle,
          sync: handle.sync.pipe(Effect.asVoid),
          writeAll: bytes =>
            Effect.promise(async () => {
              hooks.abortOnWrite?.()
              if (!hooks.pauseWrite) return
              hooks.pauseWrite = false
              await new Promise<void>(resolve => {
                hooks.releaseWrite = resolve
                hooks.onWriteStarted?.()
              })
            }).pipe(
              Effect.andThen(
                hooks.failWrite
                  ? handle
                      .writeAll(new TextEncoder().encode('partial cache payload'))
                      .pipe(Effect.andThen(Effect.fail(fileSystemError('write', 'cache write failed'))))
                  : handle.writeAll(bytes),
              ),
            ),
        }
      }),
    rename: (from, to) =>
      Effect.gen(function* () {
        hooks.renameCalls++
        const handle = openedTempFiles.at(-1)
        if (handle) hooks.closedBeforeRename.push(Exit.isFailure(yield* Effect.exit(handle.stat)))
        return yield* hooks.failRename
          ? Effect.fail(fileSystemError('rename', 'cache rename failed'))
          : fs.rename(from, to)
      }),
    remove: (path, options) => {
      if (path.endsWith('.tmp')) hooks.cleanupAfterClose.push(false)
      return fs.remove(path, options)
    },
  }
}

function runWithFileSystem<A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem>): Promise<A> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return yield* Effect.provideService(effect, FileSystem.FileSystem, hookedFileSystem(fs))
    }).pipe(Effect.provide(NodeFileSystem.layer)),
  )
}

beforeEach(async () => {
  vi.resetModules()
  root = await mkdtemp(join(tmpdir(), 'watchtower-antigravity-cache-effect-'))
  hooks.failCacheRead = false
  hooks.failWrite = false
  hooks.failClose = false
  hooks.dieClose = false
  hooks.failRename = false
  hooks.failRandomBytes = false
  hooks.renameCalls = 0
  hooks.pauseWrite = false
  hooks.abortOnWrite = undefined
  hooks.onWriteStarted = undefined
  hooks.releaseWrite = undefined
  hooks.cleanupAfterClose.length = 0
  hooks.closedBeforeRename.length = 0
  openedTempFiles = []
  const env = await import('../src/main/env.js')
  env.initAppPaths({ cacheDir: root })
  provider = await import('../src/main/pipeline/providers/antigravity.js')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function validCall() {
  return {
    provider: 'antigravity',
    model: 'fixture-model',
    inputTokens: 10,
    outputTokens: 4,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    webSearchRequests: 0,
    costUSD: 0.1,
    tools: ['read_file'],
    bashCommands: [],
    timestamp: '2026-10-01T00:00:00.000Z',
    speed: 'standard',
    deduplicationKey: 'fixture-call',
    userMessage: 'hello',
    sessionId: 'fixture-cascade',
    project: 'antigravity-cli',
    extensionFromNewerVersion: 'stripped by schema',
  }
}

async function seedCache(): Promise<{ cachePath: string; sourcePath: string; rawCache: string }> {
  const conversations = join(root, '.gemini', 'antigravity-cli', 'conversations')
  const sourcePath = join(conversations, 'fixture-cascade.pb')
  await (await import('node:fs/promises')).mkdir(conversations, { recursive: true })
  await writeFile(sourcePath, 'source')
  const sourceStat = await (await import('node:fs/promises')).stat(sourcePath)
  const cachePath = join(root, 'antigravity-results.json')
  const rawCache = JSON.stringify({
    version: 5,
    cascades: {
      'fixture-cascade': {
        mtimeMs: sourceStat.mtimeMs,
        sizeBytes: sourceStat.size,
        calls: [validCall()],
      },
    },
  })
  await writeFile(cachePath, rawCache)
  return { cachePath, sourcePath, rawCache }
}

async function loadThroughParser(sourcePath: string): Promise<unknown[]> {
  const parser = provider
    .createAntigravityProvider()
    .createSessionParser({ path: sourcePath, project: 'antigravity-cli', provider: 'antigravity' }, new Set())
  const calls: unknown[] = []
  const fs = await Effect.runPromise(Effect.provide(FileSystem.FileSystem, NodeFileSystem.layer))
  const stream = parser.parseStream().pipe(Stream.provideService(FileSystem.FileSystem, hookedFileSystem(fs)))
  for await (const call of Stream.toAsyncIterable(stream)) calls.push(call)
  return calls
}

function flushCache(liveIds?: Set<string>): Promise<void> {
  return runWithFileSystem(provider.flushAntigravityCacheEffect(liveIds))
}

async function expectTempHandleClosed(): Promise<void> {
  const handle = openedTempFiles.at(-1)
  if (!handle) throw new Error('Expected the cache temp file handle to be captured')
  await expect(Effect.runPromise(handle.stat)).rejects.toMatchObject({ reason: { cause: { code: 'EBADF' } } })
}

describe('Antigravity native cache effects', () => {
  it('decodes valid v5 calls through the parsed-call schema and preserves mutable call fields', async () => {
    const { sourcePath } = await seedCache()
    const calls = await loadThroughParser(sourcePath)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ tools: ['read_file'], deduplicationKey: 'fixture-call' })
    expect(calls[0]).not.toHaveProperty('extensionFromNewerVersion')
  })

  it('recovers from malformed JSON and filesystem read failures', async () => {
    const { cachePath, sourcePath } = await seedCache()
    await writeFile(cachePath, '{bad json')
    expect(await loadThroughParser(sourcePath)).toEqual([])

    vi.resetModules()
    const env = await import('../src/main/env.js')
    env.initAppPaths({ cacheDir: root })
    provider = await import('../src/main/pipeline/providers/antigravity.js')
    hooks.failCacheRead = true
    expect(await loadThroughParser(sourcePath)).toEqual([])
  })

  it('quietly recovers from partial write failure after close and temp cleanup', async () => {
    const { cachePath, sourcePath, rawCache } = await seedCache()
    await loadThroughParser(sourcePath)
    hooks.failWrite = true

    await expect(flushCache(new Set())).resolves.toBeUndefined()

    expect(await readFile(cachePath, 'utf-8')).toBe(rawCache)
    expect(hooks.cleanupAfterClose).toEqual([true, false])
    expect(hooks.renameCalls).toBe(0)
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])

    hooks.failWrite = false
    await flushCache()
    expect(JSON.parse(await readFile(cachePath, 'utf-8'))).toEqual({ version: 5, cascades: {} })
  })

  it('evicts absent cascades and publishes the schema-encoded cache', async () => {
    const { cachePath, sourcePath } = await seedCache()
    await loadThroughParser(sourcePath)

    await flushCache(new Set(['other-cascade']))

    expect(JSON.parse(await readFile(cachePath, 'utf-8'))).toEqual({ version: 5, cascades: {} })
    expect(hooks.closedBeforeRename).toEqual([true])
    await expectTempHandleClosed()
  })

  it('removes the temporary file after rename failure and retains the prior cache', async () => {
    const { cachePath, sourcePath, rawCache } = await seedCache()
    await loadThroughParser(sourcePath)
    hooks.failRename = true

    await flushCache(new Set())

    expect(await readFile(cachePath, 'utf-8')).toBe(rawCache)
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(hooks.cleanupAfterClose).toEqual([true, false])
    expect(hooks.closedBeforeRename).toEqual([true])
    await expectTempHandleClosed()
    await flushCache()
    expect(hooks.renameCalls).toBe(1)
  })

  it('recovers from official filesystem close defects and leaves the cache dirty for a retry', async () => {
    const { cachePath, sourcePath, rawCache } = await seedCache()
    await loadThroughParser(sourcePath)
    hooks.failClose = true

    await expect(flushCache(new Set())).resolves.toBeUndefined()
    expect(await readFile(cachePath, 'utf-8')).toBe(rawCache)
    expect(hooks.renameCalls).toBe(0)
    expect(hooks.cleanupAfterClose).toEqual([true, false])

    hooks.failClose = false
    await flushCache()
    expect(hooks.renameCalls).toBe(1)
  })

  it('recovers when a typed write failure is followed by an expected close failure', async () => {
    const { cachePath, sourcePath, rawCache } = await seedCache()
    await loadThroughParser(sourcePath)
    hooks.failWrite = true
    hooks.failClose = true

    await expect(flushCache(new Set())).resolves.toBeUndefined()

    expect(await readFile(cachePath, 'utf-8')).toBe(rawCache)
    expect(hooks.renameCalls).toBe(0)
    expect(hooks.cleanupAfterClose).toEqual([true, false])
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
    await expectTempHandleClosed()

    hooks.failWrite = false
    hooks.failClose = false
    await flushCache()
    expect(JSON.parse(await readFile(cachePath, 'utf-8'))).toEqual({ version: 5, cascades: {} })
    expect(hooks.renameCalls).toBe(1)
  })

  it('preserves defects from scoped filesystem release', async () => {
    const { sourcePath } = await seedCache()
    await loadThroughParser(sourcePath)
    hooks.dieClose = true

    await expect(flushCache(new Set())).rejects.toThrow('close defect')
    expect(hooks.renameCalls).toBe(0)
    expect(hooks.cleanupAfterClose).toEqual([true, false])
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('does not recover a write failure when scoped close also defects', async () => {
    const { sourcePath } = await seedCache()
    await loadThroughParser(sourcePath)
    hooks.failWrite = true
    hooks.dieClose = true

    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* provider
          .flushAntigravityCacheEffect(new Set())
          .pipe(Effect.provideService(FileSystem.FileSystem, hookedFileSystem(fs)))
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    )
    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(result.cause.reasons.some(Cause.isDieReason)).toBe(true)
      expect(
        result.cause.reasons.some(
          reason => Cause.isFailReason(reason) && reason.error._tag === 'AntigravityCacheIoError',
        ),
      ).toBe(true)
    }
    expect(hooks.renameCalls).toBe(0)
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
    await expectTempHandleClosed()
  })

  it('preserves an arbitrary close defect alongside a typed scan abort', async () => {
    const { sourcePath } = await seedCache()
    await loadThroughParser(sourcePath)
    const controller = new AbortController()
    hooks.abortOnWrite = () => controller.abort()
    hooks.dieClose = true

    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* provider
          .flushAntigravityCacheEffect(new Set(), controller.signal)
          .pipe(Effect.provideService(FileSystem.FileSystem, hookedFileSystem(fs)))
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    )

    expect(Exit.isFailure(result)).toBe(true)
    if (Exit.isFailure(result)) {
      expect(
        result.cause.reasons.some(reason => Cause.isFailReason(reason) && reason.error._tag === 'ScanAbortedError'),
      ).toBe(true)
      expect(result.cause.reasons.some(Cause.isDieReason)).toBe(true)
    }
    expect(hooks.renameCalls).toBe(0)
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
    await expectTempHandleClosed()
  })

  it('waits for a pending write to settle before closing and cleaning up on interruption', async () => {
    const { sourcePath } = await seedCache()
    await loadThroughParser(sourcePath)
    hooks.pauseWrite = true
    let writeStarted!: () => void
    const started = new Promise<void>(resolve => {
      writeStarted = resolve
    })
    hooks.onWriteStarted = writeStarted

    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* Effect.scoped(
          provider
            .flushAntigravityCacheEffect(new Set())
            .pipe(Effect.provideService(FileSystem.FileSystem, hookedFileSystem(fs))),
        )
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    )
    await started
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toHaveLength(1)
    expect(hooks.cleanupAfterClose).toEqual([])

    hooks.releaseWrite?.()
    await interrupted

    expect(hooks.cleanupAfterClose).toEqual([true, false])
    expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
    await expectTempHandleClosed()
  })

  it('surfaces a pre-aborted caller signal as a typed scan cancellation', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      runWithFileSystem(provider.flushAntigravityCacheEffect(undefined, controller.signal)),
    ).rejects.toMatchObject({ _tag: 'ScanAbortedError' })
  })

  it('preserves defects instead of recovering them as best-effort filesystem failures', async () => {
    const { sourcePath } = await seedCache()
    await loadThroughParser(sourcePath)
    hooks.failRandomBytes = true
    await expect(flushCache(new Set())).rejects.toThrow('crypto defect')
  })
})
