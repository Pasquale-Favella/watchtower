import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, PlatformError, Scope } from 'effect'
import { mkdtemp, readdir, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { writeCacheTempFileEffect } from '../src/main/pipeline/cache-file-write.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import { emptyCache, loadCacheEffect, saveCacheEffect } from '../src/main/pipeline/session-cache.js'

type Hook = (fs: FileSystem.FileSystem) => FileSystem.FileSystem

function withFileSystem<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem>,
  hook: Hook,
): Effect.Effect<A, E, never> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* Effect.provideService(effect, FileSystem.FileSystem, hook(fs))
  }).pipe(Effect.provide(NodeFileSystem.layer))
}

const originalCacheDir = process.env['WATCHTOWER_CACHE_DIR']
let cacheDir: string

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'watchtower-session-owned-'))
  process.env['WATCHTOWER_CACHE_DIR'] = cacheDir
})

afterEach(async () => {
  if (originalCacheDir === undefined) delete process.env['WATCHTOWER_CACHE_DIR']
  else process.env['WATCHTOWER_CACHE_DIR'] = originalCacheDir
  await rm(cacheDir, { recursive: true, force: true })
})

describe('session cache owned filesystem Effects', () => {
  it('preserves the abort identity when the staged file also fails to close', async () => {
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    const controller = new AbortController()
    const closeError = PlatformError.systemError({
      _tag: 'Unknown',
      module: 'FileSystem',
      method: 'open',
      cause: new Error('close failed'),
    })
    let openedFile: FileSystem.File | undefined
    const program = Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return yield* writeCacheTempFileEffect(fs, join(cacheDir, 'pending.tmp'), '{}', controller.signal)
    })
    const failed = withFileSystem(program, fs => ({
      ...fs,
      open: (path, options) =>
        Effect.gen(function* () {
          const scope = yield* Effect.scope
          yield* Scope.addFinalizer(scope, Effect.die(closeError))
          const file = yield* fs.open(path, options)
          openedFile = file
          return {
            ...file,
            writeAll: bytes => file.writeAll(bytes).pipe(Effect.tap(() => Effect.sync(() => controller.abort(abort)))),
          }
        }),
    }))
    expect(await Effect.runPromise(Effect.flip(failed))).toBe(abort)
    expect(openedFile).toBeDefined()
    if (openedFile) {
      await expect(Effect.runPromise(openedFile.stat)).rejects.toMatchObject({ reason: { cause: { code: 'EBADF' } } })
    }
  })

  it('retains both expected write and close failures', async () => {
    const writeError = PlatformError.systemError({
      _tag: 'Unknown',
      module: 'FileSystem',
      method: 'write',
      cause: new Error('write failed'),
    })
    const closeError = PlatformError.systemError({
      _tag: 'Unknown',
      module: 'FileSystem',
      method: 'open',
      cause: new Error('close failed'),
    })
    const effect = withFileSystem(saveCacheEffect(emptyCache()), fs => ({
      ...fs,
      open: (path, options) =>
        Effect.gen(function* () {
          const scope = yield* Effect.scope
          yield* Scope.addFinalizer(scope, Effect.die(closeError))
          const file = yield* fs.open(path, options)
          return { ...file, writeAll: () => Effect.fail(writeError) }
        }),
    }))

    const exit = await Effect.runPromise(Effect.exit(effect))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(false)
      const failures = exit.cause.reasons.filter(Cause.isFailReason).map(reason => reason.error)
      expect(failures).toContain(writeError)
      expect(failures).toContain(closeError)
    }
    expect(await readdir(cacheDir)).toEqual([])
  })

  it('keeps an expected native close failure in the typed error channel', async () => {
    const closeError = PlatformError.systemError({
      _tag: 'Unknown',
      module: 'FileSystem',
      method: 'open',
      cause: new Error('close failed'),
    })
    let openedFile: FileSystem.File | undefined
    const effect = withFileSystem(saveCacheEffect(emptyCache()), fs => ({
      ...fs,
      open: (path, options) =>
        Effect.gen(function* () {
          const scope = yield* Effect.scope
          yield* Scope.addFinalizer(scope, Effect.die(closeError))
          openedFile = yield* fs.open(path, options)
          return openedFile
        }),
    }))

    const exit = await Effect.runPromise(Effect.exit(effect))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(false)
      expect(exit.cause.reasons.filter(Cause.isFailReason).map(reason => reason.error)).toContain(closeError)
    }
    expect(openedFile).toBeDefined()
    if (openedFile) {
      await expect(Effect.runPromise(openedFile.stat)).rejects.toMatchObject({
        reason: { cause: { code: 'EBADF' } },
      })
    }
    expect(await readdir(cacheDir)).toEqual([])
  })

  it('waits for an in-flight read to settle before the interrupted load finishes', async () => {
    const started = await Effect.runPromise(Deferred.make<undefined>())
    const settleRead = await Effect.runPromise(Deferred.make<undefined>())
    let readCount = 0
    const effect = withFileSystem(loadCacheEffect(), fs => ({
      ...fs,
      readFileString: () => {
        readCount += 1
        return Effect.promise(async () => {
          await Effect.runPromise(Deferred.succeed(started, undefined))
          await Effect.runPromise(Deferred.await(settleRead))
          return JSON.stringify(emptyCache())
        })
      },
    }))

    const fiber = Effect.runFork(effect)
    await Effect.runPromise(Deferred.await(started))
    const interruption = Effect.runFork(Fiber.interrupt(fiber))
    await Effect.runPromise(Effect.yieldNow)
    expect(readCount).toBe(1)
    await Effect.runPromise(Deferred.succeed(settleRead, undefined))
    expect(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber)))).toBe(true)
    await Effect.runPromise(Fiber.join(interruption))
    expect(readCount).toBe(1)
  })

  it('closes a file handle acquired after interruption was requested during open', async () => {
    const started = await Effect.runPromise(Deferred.make<undefined>())
    const settleOpen = await Effect.runPromise(Deferred.make<undefined>())
    const order: string[] = []
    let openedFile: FileSystem.File | undefined
    const effect = withFileSystem(saveCacheEffect(emptyCache()), fs => ({
      ...fs,
      open: (path, options) =>
        Effect.gen(function* () {
          const scope = yield* Effect.scope
          yield* Scope.addFinalizer(scope, Effect.sync(() => order.push('close')).pipe(Effect.asVoid))
          order.push('open-start')
          yield* Effect.promise(async () => {
            await Effect.runPromise(Deferred.succeed(started, undefined))
            await Effect.runPromise(Deferred.await(settleOpen))
          })
          const handle = yield* fs.open(path, options)
          openedFile = handle
          order.push('open-settled')
          return handle
        }),
    }))

    const fiber = Effect.runFork(effect)
    await Effect.runPromise(Deferred.await(started))
    const interruption = Effect.runFork(Fiber.interrupt(fiber))
    await Effect.runPromise(Effect.yieldNow)
    expect(order).toEqual(['open-start'])
    await Effect.runPromise(Deferred.succeed(settleOpen, undefined))
    expect(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber)))).toBe(true)
    await Effect.runPromise(Fiber.join(interruption))

    expect(order).toEqual(['open-start', 'open-settled', 'close'])
    expect(openedFile).toBeDefined()
    if (openedFile) {
      await expect(Effect.runPromise(openedFile.stat)).rejects.toMatchObject({
        reason: { cause: { code: 'EBADF' } },
      })
    }
    expect(await readdir(cacheDir)).toEqual([])
  })

  it('closes and removes a partial temporary file before an interrupted save settles', async () => {
    const started = await Effect.runPromise(Deferred.make<undefined>())
    const settleWrite = await Effect.runPromise(Deferred.make<undefined>())
    const order: string[] = []
    let openCount = 0
    let openedFile: FileSystem.File | undefined
    const effect = withFileSystem(saveCacheEffect(emptyCache()), fs => ({
      ...fs,
      open: (path, options) =>
        Effect.gen(function* () {
          const scope = yield* Effect.scope
          yield* Scope.addFinalizer(scope, Effect.sync(() => order.push('close')).pipe(Effect.asVoid))
          const handle = yield* fs.open(path, options)
          openedFile = handle
          openCount += 1
          return {
            ...handle,
            writeAll: bytes =>
              Effect.gen(function* () {
                order.push('write-start')
                yield* Effect.promise(async () => {
                  await Effect.runPromise(Deferred.succeed(started, undefined))
                  await Effect.runPromise(Deferred.await(settleWrite))
                })
                yield* handle.writeAll(bytes)
                order.push('write-settled')
              }),
            sync: handle.sync,
          }
        }),
    }))

    const fiber = Effect.runFork(effect)
    await Effect.runPromise(Deferred.await(started))
    const interruption = Effect.runFork(Fiber.interrupt(fiber))
    await Effect.runPromise(Effect.yieldNow)
    expect(order).toEqual(['write-start'])
    await Effect.runPromise(Deferred.succeed(settleWrite, undefined))
    expect(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber)))).toBe(true)
    await Effect.runPromise(Fiber.join(interruption))

    expect(order).toEqual(['write-start', 'write-settled', 'close'])
    expect(openedFile).toBeDefined()
    if (openedFile) {
      await expect(Effect.runPromise(openedFile.stat)).rejects.toMatchObject({
        reason: { cause: { code: 'EBADF' } },
      })
    }
    expect(await readdir(cacheDir)).toEqual([])
    await expect(readFile(join(cacheDir, 'session-cache.v7.json'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(openCount).toBe(1)
  })

  it('drains an in-flight atomic rename before interruption cleanup decides whether the temp is owned', async () => {
    const started = await Effect.runPromise(Deferred.make<undefined>())
    const settleRename = await Effect.runPromise(Deferred.make<undefined>())
    const order: string[] = []
    const effect = withFileSystem(saveCacheEffect(emptyCache()), fs => ({
      ...fs,
      rename: (fromPath, toPath) =>
        Effect.gen(function* () {
          order.push('rename-start')
          yield* Effect.promise(async () => {
            await Effect.runPromise(Deferred.succeed(started, undefined))
            await Effect.runPromise(Deferred.await(settleRename))
          })
          yield* fs.rename(fromPath, toPath)
          order.push('rename-settled')
        }),
    }))

    const fiber = Effect.runFork(effect)
    await Effect.runPromise(Deferred.await(started))
    const interruption = Effect.runFork(Fiber.interrupt(fiber))
    await Effect.runPromise(Effect.yieldNow)
    expect(order).toEqual(['rename-start'])
    await Effect.runPromise(Deferred.succeed(settleRename, undefined))
    expect(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber)))).toBe(true)
    await Effect.runPromise(Fiber.join(interruption))

    expect(order).toEqual(['rename-start', 'rename-settled'])
    expect(await readdir(cacheDir)).toEqual(['session-cache.v7.json'])
    expect(JSON.parse(await readFile(join(cacheDir, 'session-cache.v7.json'), 'utf-8'))).toEqual(emptyCache())
  })
})
