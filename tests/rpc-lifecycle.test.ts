import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as PubSub from 'effect/PubSub'
import * as Queue from 'effect/Queue'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as Reactivity from 'effect/reactivity/Reactivity'
import * as Stream from 'effect/Stream'
import { describe, expect, it } from 'vitest'

import { configInvalidationRevisionAtom } from '../src/renderer/src/app/atoms/config-change.js'
import {
  type AppLifecycleReadiness,
  applyLifecycleFrame,
  createRpcLifecycleAtom,
  type LifecycleCursor,
} from '../src/renderer/src/app/atoms/rpc-lifecycle.js'
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
  it('invalidates before publishing authoritative revisions and ignores stale frames', async () => {
    const registry = AtomRegistry.make()
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
    await runFrame(configEvent(6, 5))
    await runFrame(configEvent(6, 99))
    await runFrame(resetEvent(7, 1))
    await runFrame(snapshot(0, 2, 'epoch-b', 0))

    expect(invalidations).toBe(4)
    expect(orderChecked).toBe(true)
    expect(resetBeforeInvalidation).toBe(true)
    expect(resets).toBe(2)
    expect(registry.get(configInvalidationRevisionAtom)).toBe(2)
    expect(cursor).toEqual({ epoch: 'epoch-b', generation: 0, sequence: 0 })
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
})
