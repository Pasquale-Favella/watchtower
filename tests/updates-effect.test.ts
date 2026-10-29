import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import { describe, expect, it, vi } from 'vitest'

import { AppUpdates, type UpdateDriver, UpdateError, updatesLayer } from '../src/platform/electron/main/updates.js'
import type { UpdateStatus } from '../src/shared/schemas/updates.js'

function fixture(overrides: Partial<UpdateDriver> = {}) {
  const check = vi.fn(() => ({ version: '0.3.0', available: true }))
  const download = vi.fn()
  const install = vi.fn()
  const unsubscribe = vi.fn()
  let progress: (percent: number) => void = () => {}
  const changed: UpdateStatus[] = []
  const requestInstall = vi.fn()
  const driver: UpdateDriver = {
    check: Effect.sync(check),
    download: Effect.sync(download),
    install,
    subscribeProgress: notify => {
      progress = notify
      return unsubscribe
    },
    ...overrides,
  }
  const runtime = ManagedRuntime.make(
    updatesLayer({
      currentVersion: '0.2.6',
      source: Effect.succeed({ driver, unavailableReason: null }),
      onChange: status => changed.push(status),
      requestInstall,
    }).pipe(Layer.provide(NodeFileSystem.layer)),
  )
  return {
    runtime,
    check,
    download,
    install,
    unsubscribe,
    requestInstall,
    changed,
    progress: (value: number) => progress(value),
    run: <A>(command: (updates: AppUpdates['Service']) => Effect.Effect<A>) =>
      runtime.runPromise(Effect.flatMap(AppUpdates, command)),
  }
}

describe('scoped app updates', () => {
  it('does no network work at boot and guards download/install before a check', async () => {
    const f = fixture()
    try {
      expect(await f.run(u => u.status)).toMatchObject({ phase: 'idle', installSupported: true })
      expect(await f.run(u => u.download)).toMatchObject({ phase: 'idle' })
      expect(await f.run(u => u.install)).toMatchObject({ phase: 'idle' })
      expect(f.check).not.toHaveBeenCalled()
      expect(f.download).not.toHaveBeenCalled()
      expect(f.requestInstall).not.toHaveBeenCalled()
    } finally {
      await f.runtime.dispose()
    }
    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('checks without downloading, reports progress, and requires explicit installation', async () => {
    const finish = await Effect.runPromise(Deferred.make<undefined>())
    const started = await Effect.runPromise(Deferred.make<undefined>())
    const f = fixture({
      download: Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(finish)
      }),
    })
    try {
      expect(await f.run(u => u.check)).toMatchObject({ phase: 'available', latestVersion: '0.3.0' })
      expect(f.download).not.toHaveBeenCalled()
      const downloading = f.run(u => u.download)
      await Effect.runPromise(Deferred.await(started))
      f.progress(42)
      await f.runtime.runPromise(Effect.yieldNow)
      expect(await f.run(u => u.status)).toMatchObject({ phase: 'downloading', progress: 42 })
      expect(await f.run(u => u.install)).toMatchObject({ phase: 'downloading' })
      await Effect.runPromise(Deferred.succeed(finish, undefined))
      expect(await downloading).toMatchObject({ phase: 'ready', progress: 100 })
      expect(f.requestInstall).not.toHaveBeenCalled()
      expect(await f.run(u => u.check)).toMatchObject({ phase: 'ready' })
      expect(await f.run(u => u.install)).toMatchObject({ phase: 'installing' })
      await f.run(u => u.install)
      expect(f.requestInstall).toHaveBeenCalledExactlyOnceWith(f.install)
      expect(f.install).not.toHaveBeenCalled()
      f.progress(99)
      await f.runtime.runPromise(Effect.yieldNow)
      expect(await f.run(u => u.status)).toMatchObject({ phase: 'installing', progress: 100 })
      let previousRevision = 0
      for (const status of f.changed) {
        expect(status.revision).toBeGreaterThan(previousRevision)
        previousRevision = status.revision
      }
    } finally {
      await f.runtime.dispose()
    }
  })

  it('shares one check even when its original caller is interrupted', async () => {
    const finish = await Effect.runPromise(Deferred.make<undefined>())
    const started = await Effect.runPromise(Deferred.make<undefined>())
    let checks = 0
    const f = fixture({
      check: Effect.gen(function* () {
        checks++
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(finish)
        return { version: '0.3.0', available: true }
      }),
    })
    try {
      await f.runtime.runPromise(
        Effect.gen(function* () {
          const updates = yield* AppUpdates
          const first = yield* Effect.forkChild(updates.check)
          yield* Deferred.await(started)
          const second = yield* Effect.forkChild(updates.check)
          yield* Effect.yieldNow
          yield* Fiber.interrupt(first)
          yield* Deferred.succeed(finish, undefined)
          expect(yield* Fiber.join(second)).toMatchObject({ phase: 'available' })
        }),
      )
      expect(checks).toBe(1)
    } finally {
      await f.runtime.dispose()
    }
  })

  it('clears an old successful check on failure and can retry', async () => {
    let checks = 0
    const f = fixture({
      check: Effect.suspend(() => {
        checks++
        if (checks === 2) return Effect.fail(new UpdateError({ code: 'check-failed' }))
        return Effect.succeed({ version: '0.3.0', available: checks === 1 })
      }),
    })
    try {
      expect(await f.run(u => u.check)).toMatchObject({ phase: 'available' })
      expect(await f.run(u => u.check)).toMatchObject({ phase: 'error', latestVersion: null, updateAvailable: false })
      expect(await f.run(u => u.download)).toMatchObject({ phase: 'error' })
      expect(await f.run(u => u.check)).toMatchObject({ phase: 'current', updateAvailable: false })
    } finally {
      await f.runtime.dispose()
    }
  })

  it('does not allow failed verification to install and permits a fresh download', async () => {
    let downloads = 0
    const f = fixture({
      download: Effect.suspend(() =>
        ++downloads === 1 ? Effect.fail(new UpdateError({ code: 'download-failed' })) : Effect.void,
      ),
    })
    try {
      await f.run(u => u.check)
      expect(await f.run(u => u.download)).toMatchObject({ phase: 'error', updateAvailable: true })
      await f.run(u => u.install)
      expect(f.requestInstall).not.toHaveBeenCalled()
      expect(await f.run(u => u.download)).toMatchObject({ phase: 'ready' })
    } finally {
      await f.runtime.dispose()
    }
  })

  it('shares downloads and cancels owned work on runtime disposal', async () => {
    const started = await Effect.runPromise(Deferred.make<undefined>())
    const cancelled = vi.fn()
    let downloads = 0
    const f = fixture({
      download: Effect.gen(function* () {
        downloads++
        yield* Deferred.succeed(started, undefined)
        return yield* Effect.never
      }).pipe(Effect.onInterrupt(() => Effect.sync(cancelled))),
    })
    await f.run(u => u.check)
    const first = f.run(u => u.download).catch(() => undefined)
    const second = f.run(u => u.download).catch(() => undefined)
    await Effect.runPromise(Deferred.await(started))
    await f.runtime.dispose()
    await Promise.all([first, second])
    expect(downloads).toBe(1)
    expect(cancelled).toHaveBeenCalledTimes(1)
    expect(f.unsubscribe).toHaveBeenCalledTimes(1)
    expect(f.requestInstall).not.toHaveBeenCalled()
  })

  it('provides a manual fallback without creating a driver', async () => {
    const requestInstall = vi.fn()
    const runtime = ManagedRuntime.make(
      updatesLayer({
        currentVersion: '0.2.6',
        source: Effect.succeed({ driver: null, unavailableReason: 'Use the release page.' }),
        onChange: vi.fn(),
        requestInstall,
      }).pipe(Layer.provide(NodeFileSystem.layer)),
    )
    try {
      const values = await runtime.runPromise(
        Effect.gen(function* () {
          const updates = yield* AppUpdates
          return [yield* updates.status, yield* updates.check, yield* updates.download, yield* updates.install]
        }),
      )
      for (const status of values) expect(status).toMatchObject({ phase: 'unsupported', installSupported: false })
      expect(requestInstall).not.toHaveBeenCalled()
    } finally {
      await runtime.dispose()
    }
  })
})
