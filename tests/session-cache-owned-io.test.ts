import { Deferred, Effect, Exit, Fiber } from 'effect'
import { mkdtemp, readdir, readFile, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ioHooks = vi.hoisted(() => ({
  readFile: undefined as
    ((actual: (...args: Array<unknown>) => Promise<unknown>, args: Array<unknown>) => Promise<unknown>) | undefined,
  open: undefined as
    ((actual: (...args: Array<unknown>) => Promise<unknown>, args: Array<unknown>) => Promise<unknown>) | undefined,
}))
type FsModule = typeof import('fs/promises')

vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    readFile: (...args: Array<unknown>) =>
      ioHooks.readFile
        ? ioHooks.readFile(actual.readFile as (...args: Array<unknown>) => Promise<unknown>, args)
        : (actual.readFile as (...args: Array<unknown>) => Promise<unknown>)(...args),
    open: (...args: Array<unknown>) =>
      ioHooks.open
        ? ioHooks.open(actual.open as (...args: Array<unknown>) => Promise<unknown>, args)
        : (actual.open as (...args: Array<unknown>) => Promise<unknown>)(...args),
  }
})

const originalCacheDir = process.env['WATCHTOWER_CACHE_DIR']
let cacheDir: string

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'watchtower-session-owned-io-'))
  process.env['WATCHTOWER_CACHE_DIR'] = cacheDir
})

afterEach(async () => {
  ioHooks.readFile = undefined
  ioHooks.open = undefined
  if (originalCacheDir === undefined) delete process.env['WATCHTOWER_CACHE_DIR']
  else process.env['WATCHTOWER_CACHE_DIR'] = originalCacheDir
  await rm(cacheDir, { recursive: true, force: true })
})

describe('session cache owned filesystem Effects', () => {
  it('waits for an in-flight read to settle before the interrupted load finishes', async () => {
    const started = await Effect.runPromise(Deferred.make<undefined>())
    const settleRead = await Effect.runPromise(Deferred.make<undefined>())
    let readCount = 0
    ioHooks.readFile = async (actualRead, args) => {
      readCount += 1
      await Effect.runPromise(Deferred.succeed(started, undefined))
      await Effect.runPromise(Deferred.await(settleRead))
      return actualRead(...args)
    }
    const { loadCacheEffect } = await import('../src/main/pipeline/session-cache.js')

    const fiber = Effect.runFork(loadCacheEffect())
    await Effect.runPromise(Deferred.await(started))
    const interruption = Effect.runFork(Fiber.interrupt(fiber))
    await Effect.runPromise(Effect.yieldNow)
    expect(readCount).toBe(1)
    await Effect.runPromise(Deferred.succeed(settleRead, undefined))
    expect(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber)))).toBe(true)
    await Effect.runPromise(Fiber.join(interruption))
    expect(readCount).toBe(1)
  })

  it('closes a handle acquired after interruption was requested during open', async () => {
    const started = await Effect.runPromise(Deferred.make<undefined>())
    const settleOpen = await Effect.runPromise(Deferred.make<undefined>())
    const order: string[] = []
    ioHooks.open = async (actualOpen, args) => {
      order.push('open-start')
      await Effect.runPromise(Deferred.succeed(started, undefined))
      await Effect.runPromise(Deferred.await(settleOpen))
      const handle = (await actualOpen(...args)) as Awaited<ReturnType<FsModule['open']>>
      order.push('open-settled')
      const actualClose = handle.close.bind(handle)
      return Object.assign(handle, {
        close: async () => {
          order.push('close')
          return actualClose()
        },
      })
    }
    const { emptyCache, saveCacheEffect } = await import('../src/main/pipeline/session-cache.js')

    const fiber = Effect.runFork(saveCacheEffect(emptyCache()))
    await Effect.runPromise(Deferred.await(started))
    const interruption = Effect.runFork(Fiber.interrupt(fiber))
    await Effect.runPromise(Effect.yieldNow)
    expect(order).toEqual(['open-start'])
    await Effect.runPromise(Deferred.succeed(settleOpen, undefined))
    expect(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber)))).toBe(true)
    await Effect.runPromise(Fiber.join(interruption))

    expect(order).toEqual(['open-start', 'open-settled', 'close'])
    expect(await readdir(cacheDir)).toEqual([])
  })

  it('closes and removes a partial temporary file before an interrupted save settles', async () => {
    const started = await Effect.runPromise(Deferred.make<undefined>())
    const settleWrite = await Effect.runPromise(Deferred.make<undefined>())
    const order: string[] = []
    let openCount = 0
    ioHooks.open = async (actualOpen, args) => {
      openCount += 1
      const handle = (await actualOpen(...args)) as Awaited<ReturnType<FsModule['open']>>
      const actualWrite = handle.writeFile.bind(handle)
      const actualClose = handle.close.bind(handle)
      return Object.assign(handle, {
        writeFile: async (...writeArgs: Parameters<typeof handle.writeFile>) => {
          order.push('write-start')
          await Effect.runPromise(Deferred.succeed(started, undefined))
          await Effect.runPromise(Deferred.await(settleWrite))
          await actualWrite(...writeArgs)
          order.push('write-settled')
          return handle
        },
        close: async () => {
          order.push('close')
          return actualClose()
        },
      })
    }
    const { emptyCache, saveCacheEffect } = await import('../src/main/pipeline/session-cache.js')

    const fiber = Effect.runFork(saveCacheEffect(emptyCache()))
    await Effect.runPromise(Deferred.await(started))
    const interruption = Effect.runFork(Fiber.interrupt(fiber))
    await Effect.runPromise(Effect.yieldNow)
    expect(order).toEqual(['write-start'])
    await Effect.runPromise(Deferred.succeed(settleWrite, undefined))
    expect(Exit.isFailure(await Effect.runPromise(Fiber.await(fiber)))).toBe(true)
    await Effect.runPromise(Fiber.join(interruption))

    expect(order).toEqual(['write-start', 'write-settled', 'close'])
    expect(await readdir(cacheDir)).toEqual([])
    await expect(readFile(join(cacheDir, 'session-cache.v7.json'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(openCount).toBe(1)
  })
})
