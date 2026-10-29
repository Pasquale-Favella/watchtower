import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as Fiber from 'effect/Fiber'
import * as Stream from 'effect/Stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Env } from '../src/infrastructure/config/environment.js'
import { takeQueuedLogRecords } from '../src/infrastructure/ingestion/file-errors.js'
import { discoverAllSessionsEffect, safeDiscoverSessionsEffect } from '../src/infrastructure/provider-adapters/index.js'
import type { Provider, ProviderScanContext, SessionSource } from '../src/infrastructure/provider-adapters/types.js'
import { ScanAbortedError } from '../src/core/ingestion/reconciliation/scan-control.js'
import { withProviderFileSystem } from './fixtures/provider-effects.js'
import { discoverProviderSessions } from './fixtures/provider-effects.js'
import { deferred } from './helpers/deferred.js'

function provider(name: string, discoverSessionsEffect: Provider['discoverSessionsEffect']): Provider {
  return {
    name,
    displayName: name,
    modelDisplayName: model => model,
    toolDisplayName: tool => tool,
    discoverSessionsEffect,
    createSessionParser: () => ({ parseStream: () => Stream.empty }),
  }
}

afterEach(() => {
  takeQueuedLogRecords()
})

const discoveryEnv = Env.layerWithGatewayKey(null)

function discoverAllSessionsForTest(providerFilter?: string, providerList?: Provider[], context?: ProviderScanContext) {
  return Effect.runPromise(
    withProviderFileSystem(
      discoverAllSessionsEffect(providerFilter, providerList, context).pipe(Effect.provide(discoveryEnv)),
    ),
  )
}

function safeDiscoverSessionsForTest(provider: Provider, context?: ProviderScanContext) {
  return Effect.runPromise(
    withProviderFileSystem(safeDiscoverSessionsEffect(provider, context).pipe(Effect.provide(discoveryEnv))),
  )
}

describe('provider discovery stop', () => {
  it('does not start discovery when the scan is already stopped', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    controller.abort(abort)
    const discover = vi.fn(() => Effect.succeed([]))

    await expect(
      discoverAllSessionsForTest(undefined, [provider('pre-stopped', discover)], { signal: controller.signal }),
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
    const first = vi.fn((received?: ProviderScanContext) =>
      Effect.sync(() => {
        expect(received).toBe(context)
        started.resolve(undefined)
      }).pipe(Effect.andThen(Effect.tryPromise({ try: () => pending.promise, catch: cause => cause as Error }))),
    )
    const second = vi.fn(() => Effect.succeed([]))
    const result = discoverAllSessionsForTest(
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
      return Effect.tryPromise({ try: () => pending.promise, catch: cause => cause as Error })
    })
    const result = safeDiscoverSessionsForTest(provider('rejected-stop', discover), { signal: controller.signal })
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
    await expect(safeDiscoverSessionsForTest(provider('typed-stop', () => Effect.fail(abort)))).rejects.toBe(abort)
    expect(takeQueuedLogRecords()).toEqual([])
  })

  it('still isolates ordinary provider failures and discovers the next provider', async () => {
    const source = { path: '/good', provider: 'good-after-failure', project: 'good' }
    const failing = provider('ordinary-discovery-failure', () => Effect.fail(new Error('invalid source')))
    const healthy = provider('good-after-failure', () => Effect.succeed([source]))

    await expect(discoverAllSessionsForTest(undefined, [failing, healthy])).resolves.toEqual([source])
    expect(takeQueuedLogRecords().map(record => record.fields)).toEqual([
      { op: 'scan', provider: 'ordinary-discovery-failure', code: 'discovery-failed' },
    ])
  })

  it('native discovery preserves abort identity and stops before the next provider', async () => {
    const controller = new AbortController()
    const abort = new ScanAbortedError({ message: 'scan aborted' })
    const pending = deferred<SessionSource[]>()
    const started = deferred<undefined>()
    const first = vi.fn(() =>
      Effect.sync(() => started.resolve(undefined)).pipe(
        Effect.andThen(Effect.tryPromise({ try: () => pending.promise, catch: cause => cause as Error })),
      ),
    )
    const second = vi.fn(() => Effect.succeed([]))
    const context: ProviderScanContext = { signal: controller.signal }
    const result = Effect.runPromise(
      withProviderFileSystem(
        discoverAllSessionsEffect(
          undefined,
          [provider('native-first', first), provider('native-second', second)],
          context,
        ).pipe(Effect.provide(discoveryEnv)),
      ),
    )

    await started.promise
    controller.abort(abort)
    pending.resolve([{ path: '/late', provider: 'native-first', project: 'late' }])

    await expect(result).rejects.toBe(abort)
    expect(second).not.toHaveBeenCalled()
    expect(takeQueuedLogRecords()).toEqual([])
  })

  it('runs native discovery once through the registry hook', async () => {
    const source = { path: '/native-hook', provider: 'native-hook', project: 'native' }
    const native = vi.fn(() => Effect.succeed([source]))
    const nativeProvider = provider('native-hook', native)

    await expect(
      Effect.runPromise(
        withProviderFileSystem(safeDiscoverSessionsEffect(nativeProvider).pipe(Effect.provide(discoveryEnv))),
      ),
    ).resolves.toEqual([source])
    expect(native).toHaveBeenCalledOnce()
    expect(takeQueuedLogRecords()).toEqual([])
  })

  it('isolates typed failures from native discovery and preserves cancellation identity', async () => {
    const source = { path: '/after-native-failure', provider: 'after-native-failure', project: 'healthy' }
    const failing = provider('native-expected-failure', () => Effect.fail(new Error('unavailable')))
    const healthy = provider('healthy-after-native-failure', () => Effect.succeed([source]))
    await expect(
      Effect.runPromise(
        withProviderFileSystem(
          discoverAllSessionsEffect(undefined, [failing, healthy]).pipe(Effect.provide(discoveryEnv)),
        ),
      ),
    ).resolves.toEqual([source])
    expect(takeQueuedLogRecords().map(record => record.fields)).toEqual([
      { op: 'scan', provider: 'native-expected-failure', code: 'discovery-failed' },
    ])

    const abort = new ScanAbortedError({ message: 'native stop' })
    const cancelled = provider('native-abort', () => Effect.fail(abort))
    await expect(
      Effect.runPromise(
        withProviderFileSystem(safeDiscoverSessionsEffect(cancelled).pipe(Effect.provide(discoveryEnv))),
      ),
    ).rejects.toBe(abort)
    expect(takeQueuedLogRecords()).toEqual([])

    const defect = new Error('native discovery defect')
    const defective = provider('native-defect', () => Effect.die(defect))
    const exit = await Effect.runPromise(
      withProviderFileSystem(Effect.exit(safeDiscoverSessionsEffect(defective).pipe(Effect.provide(discoveryEnv)))),
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
    const native = provider('native-interrupt', () =>
      Effect.acquireUseRelease(
        Effect.sync(() => started.resolve(undefined)),
        () => Effect.never,
        () =>
          Effect.sync(() => {
            finalized = true
          }),
      ),
    )
    const fiber = Effect.runFork(
      withProviderFileSystem(safeDiscoverSessionsEffect(native).pipe(Effect.provide(discoveryEnv))),
    )

    await started.promise
    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(finalized).toBe(true)
    expect(takeQueuedLogRecords()).toEqual([])
  })

  it('native discovery finalizer stops and drains pending IO before interruption returns', async () => {
    const pending = deferred<SessionSource[]>()
    const started = deferred<undefined>()
    let drained = false
    let stopCalled = false
    const stop = (): void => {
      stopCalled = true
      pending.resolve([{ path: '/stopped', provider: 'native-first', project: 'stopped' }])
    }
    const first = provider('native-first', () =>
      Effect.acquireUseRelease(
        Effect.sync(() => started.resolve(undefined)),
        () => Effect.tryPromise({ try: () => pending.promise, catch: cause => cause as Error }),
        () =>
          Effect.sync(stop).pipe(
            Effect.ensuring(
              Effect.promise(() =>
                pending.promise.then(() => {
                  drained = true
                }),
              ),
            ),
          ),
      ),
    )
    const second = vi.fn(() => Effect.succeed([]))
    const fiber = Effect.runFork(
      withProviderFileSystem(
        discoverAllSessionsEffect(undefined, [first, provider('native-second', second)]).pipe(
          Effect.provide(discoveryEnv),
        ),
      ),
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
      const nativeFailure = Object.assign(new Error('EACCES'), { code: 'EACCES' })
      const failing = provider(name, () =>
        Effect.tryPromise({
          try: () => {
            if (mode === 'throw') throw { code: 'EACCES' }
            return Promise.reject({ code: 'EACCES' })
          },
          catch: () => nativeFailure,
        }),
      )
      const healthy = provider(source.provider, () => Effect.succeed([source]))

      await expect(
        Effect.runPromise(
          withProviderFileSystem(
            discoverAllSessionsEffect(undefined, [failing, healthy]).pipe(Effect.provide(discoveryEnv)),
          ),
        ),
      ).resolves.toEqual([source])
      expect(takeQueuedLogRecords().map(record => record.fields)).toEqual([
        { op: 'scan', provider: name, code: 'EACCES' },
      ])
    },
  )

  it('drains native discovery even when its release callback throws a defect', async () => {
    const pending = deferred<SessionSource[]>()
    const started = deferred<undefined>()
    const stopped = deferred<undefined>()
    const stopFailure = new Error('stop callback failed')
    let drained = false
    const stop = (): never => {
      stopped.resolve(undefined)
      throw stopFailure
    }
    const first = provider('native-stop-defect', () =>
      Effect.acquireUseRelease(
        Effect.sync(() => started.resolve(undefined)),
        () => Effect.tryPromise({ try: () => pending.promise, catch: cause => cause as Error }),
        () =>
          Effect.sync(stop).pipe(
            Effect.ensuring(
              Effect.promise(() =>
                pending.promise.then(() => {
                  drained = true
                }),
              ),
            ),
          ),
      ),
    )
    const fiber = Effect.runFork(
      withProviderFileSystem(discoverAllSessionsEffect(undefined, [first]).pipe(Effect.provide(discoveryEnv))),
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
    expect(drained).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons.filter(Cause.isDieReason).map(reason => reason.defect)).toContain(stopFailure)
    }
  })

  it('Promise compatibility exports still delegate to the native workflows', async () => {
    const source = { path: '/native-edge', provider: 'native-edge', project: 'native' }
    const discover = vi.fn(() => Effect.succeed([source]))
    const expectedProvider = provider('native-edge', discover)

    await expect(discoverProviderSessions(expectedProvider)).resolves.toEqual([source])
    await expect(safeDiscoverSessionsForTest(expectedProvider)).resolves.toEqual([source])
    await expect(discoverAllSessionsForTest(undefined, [expectedProvider])).resolves.toEqual([source])
    await expect(
      Effect.runPromise(
        withProviderFileSystem(safeDiscoverSessionsEffect(expectedProvider).pipe(Effect.provide(discoveryEnv))),
      ),
    ).resolves.toEqual([source])
  })
})
