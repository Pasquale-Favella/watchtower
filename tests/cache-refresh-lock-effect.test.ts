import { Effect, Fiber } from 'effect'
import { mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { acquireCacheRefreshLockEffect } from '../src/main/pipeline/cache-refresh-lock.js'

let cacheDir: string

beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), 'watchtower-refresh-effect-'))
})

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true })
})

describe('cache refresh lock Effect', () => {
  it('acquires, verifies, and releases a refresh lock', async () => {
    const result = await Effect.runPromise(acquireCacheRefreshLockEffect({ cacheDir }))
    expect(result.outcome).toBe('acquired')
    if (result.outcome !== 'acquired') return

    expect(await Effect.runPromise(result.handle.verifyStillOwnerEffect)).toBe(true)
    await Effect.runPromise(result.handle.releaseEffect)
  })

  it('interrupts a same-process waiter without waiting for the current owner', async () => {
    const first = await Effect.runPromise(acquireCacheRefreshLockEffect({ cacheDir }))
    expect(first.outcome).toBe('acquired')
    if (first.outcome !== 'acquired') return

    const waiter = Effect.runFork(acquireCacheRefreshLockEffect({ cacheDir, waitMs: 60_000 }))
    await new Promise(resolve => setTimeout(resolve, 10))
    await Effect.runPromise(Fiber.interrupt(waiter))

    await Effect.runPromise(first.handle.releaseEffect)
    const next = await Effect.runPromise(acquireCacheRefreshLockEffect({ cacheDir, waitMs: 0 }))
    expect(next.outcome).toBe('acquired')
    if (next.outcome === 'acquired') await Effect.runPromise(next.handle.releaseEffect)
  })

  it('interrupts while polling a fresh cross-process lock', async () => {
    const lockPath = join(cacheDir, 'session-refresh.lock')
    await writeFile(lockPath, JSON.stringify({ pid: process.pid + 1, token: 'other', at: Date.now() }))

    const waiter = Effect.runFork(acquireCacheRefreshLockEffect({ cacheDir, waitMs: 60_000, pollMs: 5 }))
    await new Promise(resolve => setTimeout(resolve, 20))
    await Effect.runPromise(Fiber.interrupt(waiter))

    await unlink(lockPath)
    const next = await Effect.runPromise(acquireCacheRefreshLockEffect({ cacheDir, waitMs: 0 }))
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
    )

    expect(result.outcome).toBe('acquired')
    if (result.outcome !== 'acquired') return
    expect((await stat(lockPath)).mtimeMs).toBeGreaterThan(staleTime.getTime())
    await Effect.runPromise(result.handle.releaseEffect)
  })

  it('times out without changing a fresh lock', async () => {
    const lockPath = join(cacheDir, 'session-refresh.lock')
    await writeFile(lockPath, JSON.stringify({ pid: process.pid + 1, token: 'other', at: Date.now() }))
    let monotonic = 0

    const result = await Effect.runPromise(
      acquireCacheRefreshLockEffect({
        cacheDir,
        waitMs: 20,
        pollMs: 5,
        clock: { wallNow: () => Date.now(), monotonicNow: () => monotonic },
        sleep: async ms => {
          monotonic += ms
        },
      }),
    )

    expect(result.outcome).toBe('timed-out')
    expect(JSON.parse(await readFile(lockPath, 'utf-8')).token).toBe('other')
  })
})
