import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Env } from '../src/main/env.js'
import { takeQueuedLogRecords } from '../src/main/pipeline/file-errors.js'
import {
  discoverAllSessions,
  discoverAllSessionsEffect,
  safeDiscoverSessions,
  safeDiscoverSessionsEffect,
} from '../src/main/pipeline/providers/index.js'
import type { Provider, ProviderScanContext, SessionSource } from '../src/main/pipeline/providers/types.js'
import { ScanAbortedError } from '../src/main/pipeline/scan-control.js'
import { deferred } from './helpers/deferred.js'

function provider(
  name: string,
  discoverSessions: Provider['discoverSessions'],
  discoverSessionsEffect?: Provider['discoverSessionsEffect'],
): Provider {
  return {
    name,
    displayName: name,
    modelDisplayName: model => model,
    toolDisplayName: tool => tool,
    discoverSessions,
    ...(discoverSessionsEffect ? { discoverSessionsEffect } : {}),
    createSessionParser: () => ({ parse: async function* () {} }),
  }
}

afterEach(() => {
  takeQueuedLogRecords()
})

const discoveryEnv = Env.layerWithGatewayKey(null)

describe('provider discovery stop', () => {
  it('does not start discovery when the scan is already stopped', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    controller.abort(abort)
    const discover = vi.fn(async () => [])

    await expect(
      discoverAllSessions(undefined, [provider('pre-stopped', discover)], { signal: controller.signal }),
    ).rejects.toBe(abort)
    expect(discover).not.toHaveBeenCalled()
    expect(takeQueuedLogRecords()).toEqual([])
  })

  it('passes the scan context intact and rejects late discovery without starting another provider', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    const pending = deferred<SessionSource[]>()
    const started = deferred<undefined>()
    const context: ProviderScanContext = {
      signal: controller.signal,
      gatewayEnabled: true,
      fetchGatewayReport: vi.fn(() => Effect.succeed([])),
    }
    const first = vi.fn(async (received?: ProviderScanContext) => {
      expect(received).toBe(context)
      started.resolve(undefined)
      return pending.promise
    })
    const second = vi.fn(async () => [])
    const result = discoverAllSessions(
      undefined,
      [provider('late-first', first), provider('late-second', second)],
      context,
    )
    const rejected = expect(result).rejects.toBe(abort)
    await started.promise
    controller.abort(abort)
    pending.resolve([{ path: '/late', provider: 'late-first', project: 'late' }])

    await rejected
    expect(second).not.toHaveBeenCalled()
    expect(takeQueuedLogRecords()).toEqual([])
  })

  it('normalizes a pending discovery rejection during stop without warning', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    const pending = deferred<SessionSource[]>()
    const started = deferred<undefined>()
    const discover = vi.fn(() => {
      started.resolve(undefined)
      return pending.promise
    })
    const result = safeDiscoverSessions(provider('rejected-stop', discover), { signal: controller.signal })
    const rejected = expect(result).rejects.toBe(abort)
    await started.promise
    expect(discover).toHaveBeenCalledOnce()
    controller.abort(abort)
    pending.reject(new Error('reader closed'))

    await rejected
    expect(takeQueuedLogRecords()).toEqual([])
  })

  it('preserves a provider cancellation error even without a signal', async () => {
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    await expect(
      safeDiscoverSessions(
        provider('typed-stop', async () => {
          throw abort
        }),
      ),
    ).rejects.toBe(abort)
    expect(takeQueuedLogRecords()).toEqual([])
  })

  it('still isolates ordinary provider failures and discovers the next provider', async () => {
    const source = { path: '/good', provider: 'good-after-failure', project: 'good' }
    const failing = provider('ordinary-discovery-failure', async () => {
      throw new Error('invalid source')
    })
    const healthy = provider('good-after-failure', async () => [source])

    await expect(discoverAllSessions(undefined, [failing, healthy])).resolves.toEqual([source])
    expect(takeQueuedLogRecords().map(record => record.fields)).toEqual([
      { op: 'scan', provider: 'ordinary-discovery-failure', code: 'discovery-failed' },
    ])
  })

  it('native discovery preserves abort identity and stops before the next provider', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    const pending = deferred<SessionSource[]>()
    const started = deferred<undefined>()
    const first = vi.fn(async () => {
      started.resolve(undefined)
      return pending.promise
    })
    const second = vi.fn(async () => [])
    const context: ProviderScanContext = { signal: controller.signal }
    const result = Effect.runPromise(
      discoverAllSessionsEffect(
        undefined,
        [provider('native-first', first), provider('native-second', second)],
        context,
      ).pipe(Effect.provide(discoveryEnv)),
    )

    await started.promise
    controller.abort(abort)
    pending.resolve([{ path: '/late', provider: 'native-first', project: 'late' }])

    await expect(result).rejects.toBe(abort)
    expect(second).not.toHaveBeenCalled()
    expect(takeQueuedLogRecords()).toEqual([])
  })

  it('native registry hook bypasses the Promise discovery method', async () => {
    const source = { path: '/native-hook', provider: 'native-hook', project: 'native' }
    const legacy = vi.fn(async () => {
      throw new Error('Promise discovery should not run')
    })
    const native = vi.fn(() => Effect.succeed([source]))

    await expect(
      Effect.runPromise(
        safeDiscoverSessionsEffect(provider('native-hook', legacy, native)).pipe(Effect.provide(discoveryEnv)),
      ),
    ).resolves.toEqual([source])
    expect(native).toHaveBeenCalledOnce()
    expect(legacy).not.toHaveBeenCalled()
    expect(takeQueuedLogRecords()).toEqual([])
  })

  it('isolates typed failures from native discovery and preserves cancellation identity', async () => {
    const source = { path: '/after-native-failure', provider: 'after-native-failure', project: 'healthy' }
    const failing = provider(
      'native-expected-failure',
      async () => [],
      () => Effect.fail(new Error('unavailable')),
    )
    const healthy = provider('healthy-after-native-failure', async () => [source])
    await expect(
      Effect.runPromise(discoverAllSessionsEffect(undefined, [failing, healthy]).pipe(Effect.provide(discoveryEnv))),
    ).resolves.toEqual([source])
    expect(takeQueuedLogRecords().map(record => record.fields)).toEqual([
      { op: 'scan', provider: 'native-expected-failure', code: 'discovery-failed' },
    ])

    const abort = new ScanAbortedError({ message: 'native stop' })
    const cancelled = provider(
      'native-abort',
      async () => [],
      () => Effect.fail(abort),
    )
    await expect(
      Effect.runPromise(safeDiscoverSessionsEffect(cancelled).pipe(Effect.provide(discoveryEnv))),
    ).rejects.toBe(abort)
    expect(takeQueuedLogRecords()).toEqual([])

    const defect = new Error('native discovery defect')
    const defective = provider(
      'native-defect',
      async () => [],
      () => Effect.die(defect),
    )
    const exit = await Effect.runPromise(
      Effect.exit(safeDiscoverSessionsEffect(defective).pipe(Effect.provide(discoveryEnv))),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons.filter(Cause.isDieReason).map(reason => reason.defect)).toContain(defect)
    }
    expect(takeQueuedLogRecords()).toEqual([])
  })

  it('interrupts a native discovery Effect through its owned finalizer', async () => {
    const started = deferred<undefined>()
    let finalized = false
    const native = provider(
      'native-interrupt',
      async () => [],
      () =>
        Effect.acquireUseRelease(
          Effect.sync(() => started.resolve(undefined)),
          () => Effect.never,
          () =>
            Effect.sync(() => {
              finalized = true
            }),
        ),
    )
    const fiber = Effect.runFork(safeDiscoverSessionsEffect(native).pipe(Effect.provide(discoveryEnv)))

    await started.promise
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(finalized).toBe(true)
    expect(takeQueuedLogRecords()).toEqual([])
  })

  it('native fiber interruption calls stop and drains pending provider discovery before returning', async () => {
    const pending = deferred<SessionSource[]>()
    const started = deferred<undefined>()
    let drained = false
    const first = vi.fn(() => {
      started.resolve(undefined)
      return pending.promise.finally(() => {
        drained = true
      })
    })
    const second = vi.fn(async () => [])
    let stopCalled = false
    const stop = (): void => {
      stopCalled = true
      pending.resolve([{ path: '/stopped', provider: 'native-first', project: 'stopped' }])
    }
    const fiber = Effect.runFork(
      discoverAllSessionsEffect(undefined, [provider('native-first', first), provider('native-second', second)], {
        stop,
      }).pipe(Effect.provide(discoveryEnv)),
    )

    await started.promise
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(stopCalled).toBe(true)
    expect(drained).toBe(true)
    expect(second).not.toHaveBeenCalled()
  })

  it.each(['throw', 'reject'] as const)(
    'native discovery isolates a synchronous %s or non-Error rejection',
    async mode => {
      const name = `native-failure-${mode}`
      const source = { path: '/healthy', provider: 'healthy-native-discovery', project: 'healthy' }
      const failing = provider(name, () => {
        if (mode === 'throw') throw { code: 'EACCES' }
        return Promise.reject({ code: 'EACCES' })
      })
      const healthy = provider(source.provider, async () => [source])

      await expect(
        Effect.runPromise(discoverAllSessionsEffect(undefined, [failing, healthy]).pipe(Effect.provide(discoveryEnv))),
      ).resolves.toEqual([source])
      expect(takeQueuedLogRecords().map(record => record.fields)).toEqual([
        { op: 'scan', provider: name, code: 'EACCES' },
      ])
    },
  )

  it('drains discovery even when the stop callback throws a defect', async () => {
    const pending = deferred<SessionSource[]>()
    const started = deferred<undefined>()
    const stopped = deferred<undefined>()
    const stopFailure = new Error('stop callback failed')
    const first = provider('native-stop-defect', () => {
      started.resolve(undefined)
      return pending.promise
    })
    const fiber = Effect.runFork(
      discoverAllSessionsEffect(undefined, [first], {
        stop: () => {
          stopped.resolve(undefined)
          throw stopFailure
        },
      }).pipe(Effect.provide(discoveryEnv)),
    )
    let interrupted = false
    await started.promise
    const interruption = Effect.runPromise(Fiber.interrupt(fiber)).then(() => {
      interrupted = true
    })
    try {
      await stopped.promise
      expect(interrupted).toBe(false)
    } finally {
      pending.resolve([])
      await interruption
    }
    const exit = await Effect.runPromise(Fiber.await(fiber))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons.filter(Cause.isDieReason).map(reason => reason.defect)).toContain(stopFailure)
    }
  })

  it('Promise compatibility exports still delegate to the native workflows', async () => {
    const source = { path: '/native-edge', provider: 'native-edge', project: 'native' }
    const discover = vi.fn(async () => [source])
    const expectedProvider = provider('native-edge', discover)

    await expect(safeDiscoverSessions(expectedProvider)).resolves.toEqual([source])
    await expect(discoverAllSessions(undefined, [expectedProvider])).resolves.toEqual([source])
    await expect(
      Effect.runPromise(safeDiscoverSessionsEffect(expectedProvider).pipe(Effect.provide(discoveryEnv))),
    ).resolves.toEqual([source])
  })
})
