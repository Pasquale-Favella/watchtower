import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { it as effectIt } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import * as TestClock from 'effect/testing/TestClock'
import { mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { acquireCacheRefreshLockEffect } from '../src/infrastructure/ingestion/cache-refresh-lock.js'

let cacheDir: string

const withFileSystem = <A, E>(
  effect: Effect.Effect<A, E, import('effect/FileSystem').FileSystem>,
): Effect.Effect<A, E, never> => effect.pipe(Effect.provide(NodeFileSystem.layer))

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'watchtower-refresh-effect-'))
})

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true })
})

describe('cache refresh lock Effect', () => {
  it('acquires, verifies, and releases a refresh lock', async () => {
    const result = await Effect.runPromise(withFileSystem(acquireCacheRefreshLockEffect({ cacheDir })))
    expect(result.outcome).toBe('acquired')
    if (result.outcome !== 'acquired') return

    expect(await Effect.runPromise(result.handle.verifyStillOwnerEffect)).toBe(true)
    await Effect.runPromise(result.handle.releaseEffect)
  })

  it('interrupts a same-process waiter without waiting for the current owner', async () => {
    const first = await Effect.runPromise(withFileSystem(acquireCacheRefreshLockEffect({ cacheDir })))
    expect(first.outcome).toBe('acquired')
    if (first.outcome !== 'acquired') return

    const waiter = Effect.runFork(withFileSystem(acquireCacheRefreshLockEffect({ cacheDir, waitMs: 60_000 })))
    await new Promise(resolve => setTimeout(resolve, 10))
    await Effect.runPromise(Fiber.interrupt(waiter))

    await Effect.runPromise(first.handle.releaseEffect)
    const next = await Effect.runPromise(withFileSystem(acquireCacheRefreshLockEffect({ cacheDir, waitMs: 0 })))
    expect(next.outcome).toBe('acquired')
    if (next.outcome === 'acquired') await Effect.runPromise(next.handle.releaseEffect)
  })

  it('interrupts while polling a fresh cross-process lock', async () => {
    const lockPath = join(cacheDir, 'session-refresh.lock')
    await writeFile(lockPath, JSON.stringify({ pid: process.pid + 1, token: 'other', at: Date.now() }))

    const waiter = Effect.runFork(
      withFileSystem(acquireCacheRefreshLockEffect({ cacheDir, waitMs: 60_000, pollMs: 5 })),
    )
    await new Promise(resolve => setTimeout(resolve, 20))
    await Effect.runPromise(Fiber.interrupt(waiter))

    await unlink(lockPath)
    const next = await Effect.runPromise(withFileSystem(acquireCacheRefreshLockEffect({ cacheDir, waitMs: 0 })))
    expect(next.outcome).toBe('acquired')
    if (next.outcome === 'acquired') await Effect.runPromise(next.handle.releaseEffect)
  })

  it('takes over a stale lock with the injected clock', async () => {
    const lockPath = join(cacheDir, 'session-refresh.lock')
    let wall = Date.now()
    let monotonic = 1_000
    await writeFile(lockPath, JSON.stringify({ pid: process.pid + 1, token: 'stale', at: wall - 500 }))
    const staleTime = new Date(wall - 500)
    await utimes(lockPath, staleTime, staleTime)

    const result = await Effect.runPromise(
      withFileSystem(
        acquireCacheRefreshLockEffect({
          cacheDir,
          staleMs: 100,
          waitMs: 1_000,
          clock: { wallNow: () => wall, monotonicNow: () => monotonic },
          sleep: async ms => {
            wall += ms
            monotonic += ms
          },
        }),
      ),
    )

    expect(result.outcome).toBe('acquired')
    if (result.outcome !== 'acquired') return
    expect((await stat(lockPath)).mtimeMs).toBeGreaterThan(staleTime.getTime())
    await Effect.runPromise(result.handle.releaseEffect)
  })

  effectIt.effect('uses the Effect Clock for default wall and monotonic lock decisions', () =>
    Effect.gen(function* () {
      const lockPath = join(cacheDir, 'session-refresh.lock')
      const actualNow = Date.now()
      const staleTime = new Date(actualNow)
      yield* Effect.promise(() =>
        writeFile(lockPath, JSON.stringify({ pid: process.pid + 1, token: 'stale', at: actualNow })),
      )
      yield* Effect.promise(() => utimes(lockPath, staleTime, staleTime))

      yield* TestClock.setTime(actualNow + 2 * 60 * 60 * 1000)
      const waiter = yield* Effect.forkChild(
        withFileSystem(acquireCacheRefreshLockEffect({ cacheDir, staleMs: 60 * 60 * 1000, waitMs: 20, pollMs: 5 })),
      )
      yield* Effect.yieldNow
      yield* TestClock.adjust('20 millis')
      const result = yield* Fiber.join(waiter)

      expect(result.outcome).toBe('acquired')
      if (result.outcome === 'acquired') yield* result.handle.releaseEffect
    }),
  )

  effectIt.effect('times out on the native monotonic deadline without changing a fresh lock', () =>
    Effect.gen(function* () {
      const lockPath = join(cacheDir, 'session-refresh.lock')
      const token = 'other'
      const actualNow = Date.now()
      yield* Effect.promise(() => writeFile(lockPath, JSON.stringify({ pid: process.pid + 1, token, at: actualNow })))

      // Move wall time behind the lock record. The fresh lock must remain
      // fresh while the wait deadline advances on the monotonic clock.
      yield* TestClock.setTime(actualNow - 60_000)
      const waiter = yield* Effect.forkChild(
        withFileSystem(acquireCacheRefreshLockEffect({ cacheDir, staleMs: 60_000, waitMs: 20, pollMs: 5 })),
      )
      // Let async filesystem observations settle between clock advances so
      // each poll's native Effect.sleep is registered before its next tick.
      for (let tick = 0; tick < 8; tick++) {
        yield* Effect.promise(() => new Promise(resolve => setTimeout(resolve, 10)))
        yield* TestClock.adjust('5 millis')
      }
      const result = yield* Fiber.join(waiter)

      expect(result.outcome).toBe('timed-out')
      const contents = yield* Effect.promise(() => readFile(lockPath, 'utf-8'))
      expect(JSON.parse(contents).token).toBe(token)
    }),
  )

  it('times out without changing a fresh lock', async () => {
    const lockPath = join(cacheDir, 'session-refresh.lock')
    await writeFile(lockPath, JSON.stringify({ pid: process.pid + 1, token: 'other', at: Date.now() }))
    let monotonic = 0

    const result = await Effect.runPromise(
      withFileSystem(
        acquireCacheRefreshLockEffect({
          cacheDir,
          waitMs: 20,
          pollMs: 5,
          clock: { wallNow: () => Date.now(), monotonicNow: () => monotonic },
          sleep: async ms => {
            monotonic += ms
          },
        }),
      ),
    )

    expect(result.outcome).toBe('timed-out')
    expect(JSON.parse(await readFile(lockPath, 'utf-8')).token).toBe('other')
  })
})
