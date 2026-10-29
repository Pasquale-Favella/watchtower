import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PubSub from 'effect/PubSub'
import * as Queue from 'effect/Queue'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Reactivity from 'effect/reactivity/Reactivity'
import * as Stream from 'effect/Stream'
import { describe, expect, it, vi } from 'vitest'

import {
  appliedLedgerGenerationAtom,
  configInvalidationRevisionAtom,
} from '../src/renderer/stores/atoms/config-change.js'
import {
  APP_LIFECYCLE_CATEGORIES,
  type AppLifecycleReadiness,
  applyLifecycleFrame,
  createRpcLifecycleAtom,
  dispatchAppLifecycleEvent,
  type LifecycleCursor,
} from '../src/renderer/stores/atoms/rpc-lifecycle.js'
import { initialScanState, scanHydrationStateAtom, scanStateAtom } from '../src/renderer/stores/atoms/scan.js'
import { coachStateAtom } from '../src/renderer/features/coach-skills/atoms.js'
import { activeCurrencyAtom } from '../src/renderer/features/settings/atoms.js'
import { updatesMachineAtom } from '../src/renderer/features/settings/updates-atoms.js'
import type { AppLifecycleFrame } from '../src/shared/rpc/lifecycle.js'
import { RendererConnection, type RendererConnectionState } from '../src/shared/rpc/reconnecting-protocol.js'

const currency = { code: 'USD', symbol: '$', rate: 1 }
const updater = {
  revision: 1,
  currentVersion: '1.0.0',
  latestVersion: null,
  updateAvailable: false,
  tag: null,
  phase: 'idle' as const,
  installSupported: false,
  progress: null,
  message: null,
}

const snapshot = (
  sequence: number,
  configRevision: number,
  epoch = 'epoch-a',
  ledgerGeneration = 0,
): AppLifecycleFrame => ({
  _tag: 'Snapshot',
  role: 'app',
  state: {
    epoch,
    sequence,
    ledgerGeneration,
    configRevision,
    scanStatus: { scanned: false },
    scanActivity: { scanning: false, progress: null, error: null },
    currency,
    updater,
    harnesses: [],
  },
})

const configEvent = (sequence: number, configRevision: number, epoch = 'epoch-a'): AppLifecycleFrame => ({
  _tag: 'Event',
  envelope: {
    epoch,
    sequence,
    ledgerGeneration: 0,
    configRevision,
    event: { _tag: 'ConfigChanged', configRevision },
  },
})

const resetEvent = (sequence: number, ledgerGeneration: number, epoch = 'epoch-a'): AppLifecycleFrame => ({
  _tag: 'Event',
  envelope: {
    epoch,
    sequence,
    ledgerGeneration,
    configRevision: 0,
    event: { _tag: 'LedgerReset', ledgerGeneration },
  },
})

function makeEventSource(onSubscribe?: (offer: (frame: AppLifecycleFrame) => void, fail: () => void) => void) {
  const active = new Set<{ offer: (frame: AppLifecycleFrame) => void; fail: () => void }>()
  const categories: Array<readonly string[] | undefined> = []
  const events = (request?: { readonly categories?: readonly string[] }) => {
    categories.push(request?.categories)
    return Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* Queue.bounded<AppLifecycleFrame, Error>(16)
        const subscriber = {
          offer: (frame: AppLifecycleFrame) => Queue.offerUnsafe(queue, frame),
          fail: () => Queue.failCauseUnsafe(queue, Cause.fail(new Error('connection lost'))),
        }
        active.add(subscriber)
        yield* Effect.acquireRelease(Effect.void, () =>
          Effect.sync(() => {
            active.delete(subscriber)
          }),
        )
        onSubscribe?.(subscriber.offer, subscriber.fail)
        return Stream.fromQueue(queue)
      }),
    )
  }
  return { events, active, categories }
}

async function makeConnection(initial: RendererConnectionState) {
  const bus = await Effect.runPromise(PubSub.sliding<RendererConnectionState>({ capacity: 1, replay: 1 }))
  await Effect.runPromise(PubSub.publish(bus, initial))
  let state = initial
  const service = RendererConnection.of({
    current: Effect.sync(() => state),
    changes: Stream.fromPubSub(bus),
  })
  return {
    service,
    layer: Layer.succeed(RendererConnection, service),
    set: async (next: RendererConnectionState) => {
      state = next
      await Effect.runPromise(PubSub.publish(bus, next))
    },
  }
}

function makeLifecycleAtom(
  eventSource: ReturnType<typeof makeEventSource>,
  connection: Awaited<ReturnType<typeof makeConnection>>,
  readinessAtom = Atom.keepAlive(Atom.make<AppLifecycleReadiness>({ state: 'inactive', message: null })),
  callbacks: {
    readonly invalidate?: () => Effect.Effect<void>
    readonly resetLedger?: (registry: AtomRegistry.AtomRegistry) => void
  } = {},
) {
  const created = createRpcLifecycleAtom({
    runtime: Atom.context(),
    layer: connection.layer,
    events: () => eventSource.events({ categories: ['config', 'reset'] }),
    readinessAtom,
    invalidate: callbacks.invalidate,
    resetLedger: callbacks.resetLedger,
    onSnapshot: () => Effect.void as never,
    onEvent: () => Effect.void as never,
  })
  return { ...created, readinessAtom }
}

function waitForReadiness(registry: AtomRegistry.AtomRegistry, atom: Atom.Atom<AppLifecycleReadiness>, state: string) {
  return viWaitFor(() => expect(registry.get(atom).state).toBe(state))
}

const viWaitFor = async (assertion: () => void): Promise<void> => {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  assertion()
}

describe('root RPC lifecycle subscription', () => {
  it('requests every app category with a version-only first snapshot', () => {
    expect(APP_LIFECYCLE_CATEGORIES).toEqual(['scan', 'store', 'reset', 'config', 'currency', 'updates', 'harnesses'])
    expect(APP_LIFECYCLE_CATEGORIES).not.toContain('coach')
  })

  it('dispatches all app lifecycle categories through their single native owner', async () => {
    const registry = AtomRegistry.make()
    registry.set(scanStateAtom, initialScanState())
    registry.set(updatesMachineAtom, { state: 'uninitialized' })
    const metadata = {
      scanId: 'scan-2',
      startedAt: '2026-01-01T00:00:00Z',
      completedAt: '2026-01-01T00:00:01Z',
      portedFiles: 1,
      unchangedFiles: 0,
      failedFiles: 0,
      perProvider: [{ provider: 'codex', ported: 1, unchanged: 0, failed: 0, unparsed: 2 }],
      aborted: false,
    }
    const harness = {
      instanceId: 'codex',
      kind: 'codex' as const,
      displayName: 'Codex',
      status: 'ready' as const,
      auth: { status: 'configured' as const },
    }
    const applyStoreChanged = vi.fn(() => Effect.void)
    const events: AppLifecycleFrame[] = [
      {
        _tag: 'Event',
        envelope: {
          epoch: 'e',
          sequence: 1,
          ledgerGeneration: 0,
          configRevision: 0,
          event: { _tag: 'ScanProgress', progress: { stage: 'parse', provider: 'codex', processed: 3 } },
        },
      },
      {
        _tag: 'Event',
        envelope: {
          epoch: 'e',
          sequence: 2,
          ledgerGeneration: 0,
          configRevision: 0,
          event: { _tag: 'StoreChanged', metadata },
        },
      },
      {
        _tag: 'Event',
        envelope: {
          epoch: 'e',
          sequence: 3,
          ledgerGeneration: 0,
          configRevision: 4,
          event: { _tag: 'ConfigChanged', configRevision: 4 },
        },
      },
      {
        _tag: 'Event',
        envelope: {
          epoch: 'e',
          sequence: 4,
          ledgerGeneration: 0,
          configRevision: 4,
          event: { _tag: 'CurrencyChanged', currency },
        },
      },
      {
        _tag: 'Event',
        envelope: {
          epoch: 'e',
          sequence: 5,
          ledgerGeneration: 0,
          configRevision: 4,
          event: { _tag: 'UpdateChanged', status: { ...updater, revision: 2 } },
        },
      },
      {
        _tag: 'Event',
        envelope: {
          epoch: 'e',
          sequence: 6,
          ledgerGeneration: 0,
          configRevision: 4,
          event: { _tag: 'HarnessesChanged', rows: [harness] },
        },
      },
    ]
    for (const frame of events) {
      if (frame._tag === 'Event')
        await Effect.runPromise(dispatchAppLifecycleEvent(registry, frame.envelope.event, applyStoreChanged))
    }
    expect(registry.get(scanStateAtom)).toMatchObject({
      scanning: true,
      progress: [{ provider: 'codex', processed: 3 }],
    })
    expect(applyStoreChanged).toHaveBeenCalledExactlyOnceWith(metadata)
    expect(registry.get(configInvalidationRevisionAtom)).toBe(0)
    expect(registry.get(activeCurrencyAtom)).toEqual(currency)
    expect(registry.get(updatesMachineAtom)).toMatchObject({ state: 'synced', status: { revision: 2 } })
    expect(registry.get(coachStateAtom).harnesses).toEqual([harness])
    registry.dispose()
  })

  it('invalidates before publishing authoritative revisions and ignores stale frames', async () => {
    const registry = AtomRegistry.make()
    registry.set(appliedLedgerGenerationAtom, 9)
    const readiness = Atom.keepAlive(Atom.make<AppLifecycleReadiness>({ state: 'inactive', message: null }))
    let invalidations = 0
    let resets = 0
    let orderChecked = true
    let resetBeforeInvalidation = false
    const callbacks = {
      registry,
      readinessAtom: readiness,
      invalidate: () =>
        Effect.sync(() => {
          invalidations++
          if (invalidations === 2) orderChecked = registry.get(configInvalidationRevisionAtom) === 4
          if (invalidations === 3) resetBeforeInvalidation = resets === 1
        }),
      resetLedger: () => {
        resets++
      },
    }
    const cursor: LifecycleCursor = { epoch: undefined, generation: undefined, sequence: -1 }
    const runFrame = (frame: AppLifecycleFrame) =>
      Effect.runPromise(Effect.provide(applyLifecycleFrame(cursor, callbacks, frame), Reactivity.layer))

    await runFrame(snapshot(5, 4))
    await runFrame(snapshot(4, 99))
    await runFrame(configEvent(6, 5))
    await runFrame(configEvent(6, 99))
    await runFrame(resetEvent(7, 1))
    await runFrame(snapshot(0, 2, 'epoch-b', 0))

    expect(invalidations).toBe(4)
    expect(orderChecked).toBe(true)
    expect(resetBeforeInvalidation).toBe(true)
    expect(resets).toBe(2)
    expect(registry.get(configInvalidationRevisionAtom)).toBe(2)
    expect(registry.get(appliedLedgerGenerationAtom)).toBe(0)
    expect(cursor).toEqual({ epoch: 'epoch-b', generation: 0, sequence: 0 })
    registry.dispose()
  })

  it('resets scan hydration before invalidating a replacement ledger snapshot', async () => {
    const registry = AtomRegistry.make()
    const readinessAtom = Atom.keepAlive(Atom.make<AppLifecycleReadiness>({ state: 'inactive', message: null }))
    registry.set(scanStateAtom, { ...initialScanState(), hydrated: true, detectedProviders: ['old'] })
    registry.set(scanHydrationStateAtom, 'scanned')
    const cursor: LifecycleCursor = { epoch: undefined, generation: undefined, sequence: -1 }
    const callbacks = {
      registry,
      readinessAtom,
      invalidate: () => Effect.void,
      resetLedger: () => undefined,
    }
    const runFrame = (frame: AppLifecycleFrame) =>
      Effect.runPromise(Effect.provide(applyLifecycleFrame(cursor, callbacks, frame), Reactivity.layer))

    await runFrame(snapshot(5, 1))
    expect(registry.get(scanHydrationStateAtom)).toBe('scanned')
    registry.set(scanStateAtom, { ...registry.get(scanStateAtom), hydrated: true, detectedProviders: ['old'] })
    await runFrame(snapshot(0, 2, 'epoch-b', 0))

    expect(registry.get(scanHydrationStateAtom)).toBe('pending')
    expect(registry.get(scanStateAtom)).toMatchObject({ hydrated: false, detectedProviders: [] })
    registry.dispose()
  })

  it('fails startup visibly, waits for connection, subscribes once, and releases on registry disposal', async () => {
    const eventSource = makeEventSource(offer => offer(snapshot(0, 3)))
    const connection = await makeConnection({ _tag: 'Failed', reason: 'unavailable' })
    const lifecycle = makeLifecycleAtom(eventSource, connection)
    const registry = AtomRegistry.make()
    const unmount = registry.mount(lifecycle.atom)
    try {
      await waitForReadiness(registry, lifecycle.readinessAtom, 'failed')
      expect(registry.get(lifecycle.readinessAtom).message).toBe('Application connection unavailable. Reconnecting.')
      expect(eventSource.categories).toHaveLength(0)
      await connection.set({ _tag: 'Connected', generation: 1 })
      await waitForReadiness(registry, lifecycle.readinessAtom, 'ready')
      expect(eventSource.categories).toEqual([['config', 'reset']])
      expect(registry.get(configInvalidationRevisionAtom)).toBe(3)
    } finally {
      unmount()
      registry.dispose()
    }
    expect(eventSource.active.size).toBe(0)
  })

  it('reconnects with fresh snapshots and resubscribes when an event reports a new epoch', async () => {
    let subscription = 0
    let activeAtThirdSubscription = 0
    const failures: Array<() => void> = []
    const offers: Array<(frame: AppLifecycleFrame) => void> = []
    const eventSource = makeEventSource((offer, fail) => {
      subscription++
      failures.push(fail)
      offers.push(offer)
      if (subscription === 1) offer(snapshot(0, 1))
      else if (subscription === 2) {
        offer(snapshot(10, 8))
        offer(configEvent(11, 9, 'epoch-b'))
        offer(configEvent(12, 100))
      } else {
        if (subscription === 3) activeAtThirdSubscription = eventSource.active.size
        offer(snapshot(0, 9, 'epoch-b', 1))
      }
    })
    const connection = await makeConnection({ _tag: 'Connected', generation: 1 })
    let invalidations = 0
    let resets = 0
    const lifecycle = makeLifecycleAtom(eventSource, connection, undefined, {
      invalidate: () => Effect.sync(() => invalidations++),
      resetLedger: () => resets++,
    })
    const registry = AtomRegistry.make()
    const unmount = registry.mount(lifecycle.atom)
    try {
      await waitForReadiness(registry, lifecycle.readinessAtom, 'ready')
      expect(registry.get(configInvalidationRevisionAtom)).toBe(1)
      failures[0]?.()
      await waitForReadiness(registry, lifecycle.readinessAtom, 'failed')
      await connection.set({ _tag: 'Disconnected', reason: 'closed' })
      await connection.set({ _tag: 'Connected', generation: 2 })
      await waitForReadiness(registry, lifecycle.readinessAtom, 'ready')
      await viWaitFor(() => expect(subscription).toBe(3))
      expect(registry.get(configInvalidationRevisionAtom)).toBe(9)
      expect(activeAtThirdSubscription).toBe(1)
      expect(invalidations).toBeGreaterThanOrEqual(3)
      expect(resets).toBe(1)
      offers[2]?.(resetEvent(1, 2, 'epoch-b'))
      await viWaitFor(() => expect(resets).toBe(2))
      expect(invalidations).toBeGreaterThanOrEqual(4)
    } finally {
      unmount()
      registry.dispose()
    }
    expect(eventSource.active.size).toBe(0)
  })

  it('cancels scoped snapshot hydration when a subscription ends without blocking snapshot handling', async () => {
    let subscription = 0
    const eventSource = makeEventSource(offer => {
      subscription++
      offer(snapshot(0, subscription))
    })
    const connection = await makeConnection({ _tag: 'Connected', generation: 1 })
    const readinessAtom = Atom.keepAlive(Atom.make<AppLifecycleReadiness>({ state: 'inactive', message: null }))
    let snapshots = 0
    let started = 0
    let finalized = 0
    const lifecycle = createRpcLifecycleAtom({
      runtime: Atom.context(),
      layer: connection.layer,
      events: () => eventSource.events(),
      readinessAtom,
      invalidate: () => Effect.void,
      onSnapshot: () =>
        Effect.gen(function* () {
          snapshots++
          yield* Effect.forkScoped(
            Effect.acquireRelease(
              Effect.sync(() => started++),
              () => Effect.sync(() => finalized++),
            ).pipe(Effect.andThen(Effect.never)),
          )
        }) as never,
      onEvent: () => Effect.void as never,
    })
    const registry = AtomRegistry.make()
    const unmount = registry.mount(lifecycle.atom)
    try {
      await waitForReadiness(registry, readinessAtom, 'ready')
      await viWaitFor(() => expect(started).toBe(1))
      expect(snapshots).toBe(1)

      for (const subscriber of eventSource.active) subscriber.fail()
      await viWaitFor(() => expect(finalized).toBe(1))
      await waitForReadiness(registry, readinessAtom, 'failed')

      await connection.set({ _tag: 'Disconnected', reason: 'reconnect' })
      await connection.set({ _tag: 'Connected', generation: 2 })
      await waitForReadiness(registry, readinessAtom, 'ready')
      expect(snapshots).toBe(2)
      expect(subscription).toBe(2)
      expect(finalized).toBe(1)
    } finally {
      unmount()
      registry.dispose()
    }
    expect(finalized).toBe(2)
    expect(eventSource.active.size).toBe(0)
  })
})
