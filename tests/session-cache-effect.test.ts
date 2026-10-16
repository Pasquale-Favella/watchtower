import { Deferred, Effect, Exit, Fiber } from 'effect'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  beginColdHydrationEffect,
  emptyCache,
  type HydrationHandleEffect,
  loadCacheEffect,
  saveCacheEffect,
} from '../src/main/pipeline/session-cache.js'

const originalCacheDir = process.env['WATCHTOWER_CACHE_DIR']
let cacheDir: string

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'watchtower-session-effect-'))
  process.env['WATCHTOWER_CACHE_DIR'] = cacheDir
})

afterEach(async () => {
  if (originalCacheDir === undefined) delete process.env['WATCHTOWER_CACHE_DIR']
  else process.env['WATCHTOWER_CACHE_DIR'] = originalCacheDir
  await rm(cacheDir, { recursive: true, force: true })
})

async function withColdHydration<A>(use: (release: Effect.Effect<void, Error>) => Promise<A>): Promise<A> {
  const handle = await Effect.runPromise(beginColdHydrationEffect(true))
  try {
    return await use(handle.release)
  } finally {
    await Effect.runPromise(handle.release)
  }
}

describe('session cache Effects', () => {
  it('writes and reloads a cache through the Effect API', async () => {
    const cache = emptyCache()
    cache.complete = true

    expect(await Effect.runPromise(saveCacheEffect(cache))).toBe(true)
    expect(await Effect.runPromise(loadCacheEffect())).toEqual(cache)
  })

  it('does not publish when the owner fence rejects the write', async () => {
    const cache = emptyCache()

    expect(await Effect.runPromise(saveCacheEffect(cache, () => Effect.succeed(false)))).toBe(false)
    expect(await Effect.runPromise(loadCacheEffect())).toEqual(emptyCache())
  })

  it('serializes same-process cold owners and lets a waiter reload after the owner releases', async () => {
    await withColdHydration(async ownerRelease => {
      const started = await Effect.runPromise(Deferred.make<undefined>())
      const waiter = Effect.runFork(
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          return yield* beginColdHydrationEffect(true)
        }),
      )
      let waited: HydrationHandleEffect | undefined
      try {
        await Effect.runPromise(Deferred.await(started))
        await Effect.runPromise(Effect.yieldNow)
        await Effect.runPromise(ownerRelease)
        waited = await Effect.runPromise(Fiber.join(waiter))
        expect(waited.waited).toBe(true)
        await expect(readFile(join(cacheDir, 'hydrating.lock'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        if (waited) await Effect.runPromise(waited.release)
        else await Effect.runPromise(Fiber.interrupt(waiter))
      }
    })
  })

  it('does not let an interrupted same-process waiter remove the active owner lock', async () => {
    await withColdHydration(async ownerRelease => {
      const started = await Effect.runPromise(Deferred.make<undefined>())
      const waiter = Effect.runFork(
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          return yield* beginColdHydrationEffect(true)
        }),
      )
      try {
        await Effect.runPromise(Deferred.await(started))
        await Effect.runPromise(Effect.yieldNow)
        await Effect.runPromise(Fiber.interrupt(waiter))
        const exit = await Effect.runPromise(Fiber.await(waiter))
        const ownerLock = await readFile(join(cacheDir, 'hydrating.lock'), 'utf-8')
        expect(Exit.isFailure(exit)).toBe(true)
        expect(JSON.parse(ownerLock)).toMatchObject({ pid: process.pid })

        await Effect.runPromise(ownerRelease)
        await withColdHydration(async () => {
          expect(JSON.parse(await readFile(join(cacheDir, 'hydrating.lock'), 'utf-8'))).toMatchObject({
            pid: process.pid,
          })
        })
      } finally {
        await Effect.runPromise(Fiber.interrupt(waiter))
      }
    })
  })

  it('reclaims a same-PID lock when no in-process owner holds the permit', async () => {
    await writeFile(join(cacheDir, 'hydrating.lock'), JSON.stringify({ pid: process.pid, at: Date.now() }))

    await withColdHydration(async () => {
      expect(JSON.parse(await readFile(join(cacheDir, 'hydrating.lock'), 'utf-8'))).toMatchObject({
        pid: process.pid,
      })
    })
    await expect(readFile(join(cacheDir, 'hydrating.lock'), 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the successor lock and permit when the old owner releases again', async () => {
    const owner = await Effect.runPromise(beginColdHydrationEffect(true))
    await Effect.runPromise(owner.release)

    await withColdHydration(async successorRelease => {
      const successorLock = await readFile(join(cacheDir, 'hydrating.lock'), 'utf-8')
      await Effect.runPromise(owner.release)
      expect(await readFile(join(cacheDir, 'hydrating.lock'), 'utf-8')).toBe(successorLock)

      const started = await Effect.runPromise(Deferred.make<undefined>())
      const waiter = Effect.runFork(
        Effect.gen(function* () {
          yield* Deferred.succeed(started, undefined)
          return yield* beginColdHydrationEffect(true)
        }),
      )
      try {
        await Effect.runPromise(Deferred.await(started))
        await Effect.runPromise(Effect.yieldNow)
        await Effect.runPromise(Fiber.interrupt(waiter))
        expect(Exit.isFailure(await Effect.runPromise(Fiber.await(waiter)))).toBe(true)
        await Effect.runPromise(successorRelease)
      } finally {
        await Effect.runPromise(Fiber.interrupt(waiter))
      }
    })
  })
})
