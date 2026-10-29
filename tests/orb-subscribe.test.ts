import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import * as AtomRpc from 'effect/reactivity/AtomRpc'
import * as Reactivity from 'effect/reactivity/Reactivity'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as Stream from 'effect/Stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { configInvalidationRevisionAtom } from '../src/renderer/src/app/atoms/config-change.js'
import { initialScanState } from '../src/renderer/src/app/atoms/scan.js'
import { scanStateAtom } from '../src/renderer/src/app/atoms/scan.js'
import { activeCurrencyAtom } from '../src/renderer/src/features/settings/atoms.js'
import { applyBeaconLifecycleFrame } from '../src/renderer/src/orb/beacon-wiring.js'
import { subscribeToOrbBeacon } from '../src/renderer/src/orb/beacon-wiring.js'
import {
  applyPanelLifecycleFrame,
  panelEventsReadyAtom,
  subscribeToOrbPanel,
} from '../src/renderer/src/orb/panel-wiring.js'
import type { RoleLifecycleCursor } from '../src/renderer/src/shared/lib/rpc-events.js'
import { runRoleLifecycle } from '../src/renderer/src/shared/lib/rpc-events.js'
import { PanelRpcGroup } from '../src/shared/rpc/application.js'
import type { RpcBridge } from '../src/shared/rpc/bridge.js'
import type { BeaconLifecycleFrame, PanelLifecycleFrame } from '../src/shared/rpc/lifecycle.js'
import { LifecycleRpcError } from '../src/shared/rpc/lifecycle.js'
import { RendererConnection } from '../src/shared/rpc/reconnecting-protocol.js'
import type { OrbPlacement } from '../src/shared/schemas/orb.js'

let registry: AtomRegistry.AtomRegistry
const placement = { expanded: false, peek: false, horizontal: 'left', vertical: 'top' } satisfies OrbPlacement

/** The renderer API exposes only the versioned RPC transport and runtime metadata. */
function orbWindow() {
  const storage = new Map<string, string>()
  const events = new Map<string, (event: unknown) => void>()
  const unsubscribe = vi.fn()
  const rpcV1: RpcBridge = {
    connect: vi.fn(async () => ({ _tag: 'Connected', generation: 1 }) as const),
    send: vi.fn(async () => undefined),
    onMessage: vi.fn(() => unsubscribe),
    onClose: vi.fn(() => unsubscribe),
    disconnect: vi.fn(),
  }
  const api = {
    rpcV1,
    platform: 'win32',
    versions: { electron: 'test', chrome: 'test', node: 'test' },
  }
  vi.stubGlobal('window', {
    api,
    document: { documentElement: { classList: { toggle: vi.fn() } } },
    matchMedia: () => ({ matches: false }),
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => void storage.set(key, value),
      removeItem: (key: string) => void storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size
      },
    },
    addEventListener: (type: string, cb: (event: unknown) => void) => events.set(type, cb),
    removeEventListener: (type: string) => events.delete(type),
  })
  return { api, events, unsubscribe }
}

beforeEach(() => {
  registry = AtomRegistry.make()
  registry.set(scanStateAtom, initialScanState())
})
afterEach(() => {
  registry.dispose()
  vi.unstubAllGlobals()
})

describe('beacon RPC lifecycle', () => {
  it('hydrates scan state and folds progress without querying ledger data', async () => {
    const { api } = orbWindow()
    const cursor: RoleLifecycleCursor = { epoch: undefined, sequence: -1, generation: undefined }
    const snapshot: BeaconLifecycleFrame = {
      _tag: 'Snapshot',
      role: 'beacon',
      state: {
        epoch: 'epoch-1',
        sequence: 0,
        scanActivity: { scanning: false, progress: null, error: null },
      },
    }
    await Effect.runPromise(applyBeaconLifecycleFrame(snapshot, cursor, registry))
    await Effect.runPromise(
      applyBeaconLifecycleFrame(
        {
          _tag: 'Event',
          envelope: {
            epoch: 'epoch-1',
            sequence: 1,
            event: { _tag: 'ScanProgress', progress: { stage: 'parse', provider: 'openai', processed: 1, total: 4 } },
          },
        },
        cursor,
        registry,
      ),
    )
    expect(registry.get(scanStateAtom)).toMatchObject({ scanning: true, stage: 'parse' })
    expect(Object.keys(api).sort()).toEqual(['platform', 'rpcV1', 'versions'])
    expect(api).not.toHaveProperty('orb')
  })

  it('keeps transport failure separate from scan activity', async () => {
    const { api } = orbWindow()
    const teardown = subscribeToOrbBeacon(registry)
    await flushEvents()
    expect(registry.get(scanStateAtom)).toEqual(initialScanState())
    expect(api.rpcV1.connect).toHaveBeenCalled()
    expect(api).not.toHaveProperty('orb')
    teardown()
  })
})

describe('panel RPC lifecycle and placement adapter', () => {
  it('subscribes to placement through role-scoped RPC with no legacy native listeners', async () => {
    const { api } = orbWindow()
    const teardown = subscribeToOrbPanel(registry)
    await flushEvents()
    expect(api.rpcV1.connect).toHaveBeenCalled()
    expect(api.rpcV1.send).toHaveBeenCalled()
    expect(api.rpcV1.onMessage).toHaveBeenCalled()
    expect(api).not.toHaveProperty('orb')
    teardown()
  })

  it('uses the root-owned preference storage listener and does not add legacy data listeners', async () => {
    const browser = orbWindow()
    const { initializeRendererWindow } = await import('../src/renderer/src/app/renderer-root.js')
    const { createRendererRuntimeOwner } = await import('../src/renderer/src/app/renderer-runtime.js')
    const { preferencesAtom } = await import('../src/renderer/src/features/settings/preferences-atoms.js')
    const owner = createRendererRuntimeOwner()
    const disposeRoot = initializeRendererWindow(window, { owner })
    const storageListener = browser.events.get('storage')
    expect(storageListener).toBeDefined()
    const teardown = subscribeToOrbPanel(registry)
    await flushEvents()
    expect(browser.events.get('storage')).toBe(storageListener)
    expect(browser.api).not.toHaveProperty('orb')
    storageListener?.({
      key: 'watchtower:settings',
      newValue: JSON.stringify({ state: { theme: 'dark' }, version: 0 }),
    })
    expect(owner.registry.get(preferencesAtom).theme).toBe('dark')
    teardown()
    expect(browser.events.get('storage')).toBe(storageListener)
    disposeRoot()
  })

  it('hydrates the panel snapshot, invalidates config once, and repaints currency without a refetch event', async () => {
    const { api } = orbWindow()
    const cursor: RoleLifecycleCursor = { epoch: undefined, sequence: -1, generation: undefined }
    const snapshot: PanelLifecycleFrame = {
      _tag: 'Snapshot',
      role: 'panel',
      state: {
        epoch: 'epoch-1',
        sequence: 0,
        hasScanned: true,
        scanActivity: { scanning: false, progress: null, error: null },
        currency: { code: 'EUR', symbol: '€', rate: 0.9 },
        resetGeneration: 0,
      },
    }
    await Effect.runPromise(applyPanelLifecycleFrame(snapshot, cursor, registry).pipe(Effect.provide(Reactivity.layer)))
    const config: PanelLifecycleFrame = {
      _tag: 'Event',
      envelope: {
        epoch: 'epoch-1',
        sequence: 1,
        ledgerGeneration: 0,
        configRevision: 3,
        event: { _tag: 'ConfigChanged', configRevision: 3 },
      },
    }
    await Effect.runPromise(applyPanelLifecycleFrame(config, cursor, registry).pipe(Effect.provide(Reactivity.layer)))
    const currency: PanelLifecycleFrame = {
      _tag: 'Event',
      envelope: {
        epoch: 'epoch-1',
        sequence: 2,
        ledgerGeneration: 0,
        configRevision: 3,
        event: { _tag: 'CurrencyChanged', currency: { code: 'JPY', symbol: '¥', rate: 150 } },
      },
    }
    await Effect.runPromise(applyPanelLifecycleFrame(currency, cursor, registry).pipe(Effect.provide(Reactivity.layer)))
    expect(registry.get(scanStateAtom).hydrated).toBe(true)
    expect(registry.get(activeCurrencyAtom)).toMatchObject({ code: 'JPY', rate: 150 })
    expect(registry.get(configInvalidationRevisionAtom)).toBe(3)
    expect(api).not.toHaveProperty('getOverview')
  })

  it('resnapshots after a dropped role stream and releases the RPC subscriber on disposal', async () => {
    const factory = Atom.context()
    const active = new Set<number>()
    let subscriptions = 0
    const firstSnapshot: PanelLifecycleFrame = {
      _tag: 'Snapshot',
      role: 'panel',
      state: {
        epoch: 'epoch-1',
        sequence: 0,
        hasScanned: true,
        scanActivity: { scanning: false, progress: null, error: null },
        currency: { code: 'USD', symbol: '$', rate: 1 },
        resetGeneration: 0,
      },
    }
    const reconnectSnapshot: PanelLifecycleFrame = {
      ...firstSnapshot,
      state: { ...firstSnapshot.state, sequence: 4, hasScanned: false },
    }
    const handlers = PanelRpcGroup.toLayer(
      PanelRpcGroup.of({
        'overview:query': () => Effect.succeed(null),
        'scan:start': () => Effect.succeed({ ok: true }),
        'panel:events': () => {
          subscriptions++
          if (subscriptions === 1)
            return Stream.concat(
              Stream.make(firstSnapshot),
              Stream.fail(new LifecycleRpcError({ code: 'lagged', message: 'Lifecycle subscriber fell behind' })),
            )
          return Stream.concat(
            Stream.make(reconnectSnapshot),
            Stream.unwrap(
              Effect.acquireRelease(
                Effect.sync(() => {
                  active.add(subscriptions)
                  return subscriptions
                }),
                id => Effect.sync(() => active.delete(id)),
              ).pipe(Effect.as(Stream.never)),
            ),
          )
        },
        'shell:events': () => Stream.make({ _tag: 'Ready', placement }),
        'shell:notice': () => Effect.void,
        'shell:open-external': () => Effect.void,
        'shell:open-settings': () => Effect.succeed(false),
        'orb:placement': () => Effect.succeed(placement),
        'orb:command': () => Effect.succeed(placement),
      }),
    )
    const client = AtomRpc.Service<object>()('test/OrbLifecycleRpc', {
      group: PanelRpcGroup,
      protocol: Layer.empty,
      runtime: factory,
      makeEffect: RpcTest.makeClient(PanelRpcGroup, { flatten: true }).pipe(Effect.provide(handlers)),
    })
    const connectionLayer = Layer.succeed(
      RendererConnection,
      RendererConnection.of({
        current: Effect.succeed({ _tag: 'Connected', generation: 1 }),
        changes: Stream.never,
      }),
    )
    const lifecycleRuntime = factory(get => Layer.merge(get(client.runtime.layer), connectionLayer))
    const readiness = panelEventsReadyAtom
    const lifecycle = lifecycleRuntime.atom(get =>
      runRoleLifecycle(get, {
        readinessAtom: readiness,
        events: () =>
          Effect.gen(function* () {
            const rpc = yield* client
            return rpc('panel:events', undefined)
          }),
        apply: applyPanelLifecycleFrame,
      }),
    )
    const owner = AtomRegistry.make()
    const stop = owner.mount(lifecycle)
    try {
      await vi.waitFor(() => expect(subscriptions).toBeGreaterThanOrEqual(2))
      await vi.waitFor(() => expect(owner.get(readiness)).toBe('ready'))
      expect(owner.get(scanStateAtom).hydrated).toBe(false)
      await vi.waitFor(() => expect(active.size).toBe(1))
    } finally {
      stop()
      owner.dispose()
    }
    await vi.waitFor(() => expect(active.size).toBe(0))
  })

  it('releases RPC transport listeners on teardown', async () => {
    const { api, unsubscribe } = orbWindow()
    const teardown = subscribeToOrbPanel(registry)
    await flushEvents()
    teardown()
    await flushEvents()
    expect(unsubscribe).toHaveBeenCalled()
    expect(api.rpcV1.disconnect).toHaveBeenCalled()
  })
})

async function flushEvents(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}
