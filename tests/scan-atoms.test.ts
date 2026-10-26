import * as Effect from 'effect/Effect'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createRemoteQuerySlot } from '../src/renderer/src/app/atoms/remote-query.js'
import { createScanAtoms } from '../src/renderer/src/app/atoms/scan.js'
import { makeScanRpcTestClient } from './scan-rpc-test-helper.js'

const registries: AtomRegistry.AtomRegistry[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
  vi.unstubAllGlobals()
})

const metadata = {
  scanId: 'scan',
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:00:01Z',
  portedFiles: 0,
  unchangedFiles: 0,
  failedFiles: 0,
  perProvider: [],
  aborted: false,
}

function setup(overrides: Parameters<typeof makeScanRpcTestClient>[1] = {}) {
  vi.stubGlobal('window', { api: { platform: 'darwin' } })
  const registry = AtomRegistry.make()
  registries.push(registry)
  const factory = Atom.context()
  const client = makeScanRpcTestClient(factory, {
    status: () => Effect.succeed({ scanned: true, metadata }),
    analytics: () => Effect.succeed(null),
    active: () => Effect.succeed(false),
    ...overrides,
  })
  const atoms = createScanAtoms(client, factory)
  return { registry, factory, client, ...atoms }
}

function read<A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<import('effect/reactivity/AsyncResult').AsyncResult<A, E>>,
) {
  return Effect.runPromise(AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }))
}

function run<A, E>(registry: AtomRegistry.AtomRegistry, atom: Atom.AtomResultFn<undefined, A, E>): Promise<A> {
  registry.set(atom, undefined)
  return read(registry, atom)
}

describe('native scan lifecycle', () => {
  it('preserves provider order and never rewinds the stage', () => {
    const { registry, scanStateAtom, scanProgressAtom, scanIdleAtom } = setup()
    for (const progress of [
      { stage: 'pricing' },
      { stage: 'parse', provider: 'a', processed: 1 },
      { stage: 'parse', provider: 'b', processed: 2 },
      { stage: 'port-in', provider: 'a', processed: 4 },
      { stage: 'parse', provider: 'b', processed: 5 },
    ] as const)
      registry.set(scanProgressAtom, progress)
    expect(registry.get(scanStateAtom)).toMatchObject({
      scanning: true,
      stage: 'port-in',
      progress: [
        { provider: 'a', processed: 4, done: true },
        { provider: 'b', processed: 5, done: false },
      ],
    })
    registry.set(scanIdleAtom, undefined)
    expect(registry.get(scanStateAtom)).toMatchObject({ scanning: false, stage: null, progress: [] })
  })

  it('invalidates activated queries even if metadata hydration fails', async () => {
    const { registry, client, applyScanChangeAtom, scanStateAtom, scanProgressAtom } = setup({
      status: () => Effect.fail(new Error('unavailable')),
    })
    let calls = 0
    const query = createRemoteQuerySlot({
      runtime: client.runtime,
      key: (request: string) => request,
      fetch: () => Effect.sync(() => ++calls),
      reactivityKeys: ['ledger'],
    })
    registry.set(query.requestAtom, 'current')
    query.pin(registry)
    expect(await read(registry, query.resultAtom)).toBe(1)
    registry.set(scanProgressAtom, { stage: 'port-in' })
    registry.set(applyScanChangeAtom, undefined)
    await read(registry, applyScanChangeAtom)
    await vi.waitFor(() => expect(calls).toBe(2))
    expect(registry.get(scanStateAtom)).toMatchObject({ scanError: 'Configuration command failed', scanning: true })
  })

  it('keeps active scan progress when a pricing change invalidates queries', async () => {
    const { registry, scanStateAtom, scanProgressAtom, applyConfigChangeAtom } = setup()
    registry.set(scanProgressAtom, { stage: 'parse', provider: 'claude', processed: 3 })
    registry.set(applyConfigChangeAtom, undefined)
    await read(registry, applyConfigChangeAtom)
    expect(registry.get(scanStateAtom)).toMatchObject({
      scanning: true,
      stage: 'parse',
      progress: [{ provider: 'claude', processed: 3 }],
    })
  })

  it('invalidates config changes without hydrating metadata over active progress', async () => {
    const status = vi.fn(() => Effect.succeed({ scanned: true, metadata }))
    const { registry, scanStateAtom, scanProgressAtom, applyConfigChangeAtom } = setup({ status })
    registry.set(scanProgressAtom, { stage: 'parse', provider: 'claude', processed: 3 })
    registry.set(applyConfigChangeAtom, undefined)
    await read(registry, applyConfigChangeAtom)
    expect(status).not.toHaveBeenCalled()
    expect(registry.get(scanStateAtom)).toMatchObject({ scanning: true, progress: [{ provider: 'claude' }] })
  })

  it('hydrates metadata and the Full Disk Access signal while clearing failed provider reads', async () => {
    const { registry, scanStateAtom, applyScanChangeAtom, hydrateScanProvidersAtom } = setup()
    registry.mount(hydrateScanProvidersAtom)
    registry.set(scanStateAtom, { ...registry.get(scanStateAtom), detectedProviders: ['old'] })
    registry.set(applyScanChangeAtom, undefined)
    await read(registry, applyScanChangeAtom)
    await vi.waitFor(() => expect(registry.get(scanStateAtom).detectedProviders).toEqual([]))
    expect(registry.get(scanStateAtom)).toMatchObject({
      hydrated: true,
      fdaNeeded: true,
      detectedProviders: [],
    })
  })

  it('does not erase new scan progress with an older metadata response', async () => {
    let resolve!: (value: { scanned: boolean; metadata: typeof metadata }) => void
    const { registry, scanStateAtom, scanProgressAtom, applyScanChangeAtom } = setup({
      status: () =>
        Effect.promise(
          () =>
            new Promise(done => {
              resolve = done
            }),
        ),
    })
    registry.set(applyScanChangeAtom, undefined)
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    registry.set(scanProgressAtom, { stage: 'parse', provider: 'new', processed: 1 })
    resolve({ scanned: true, metadata })
    await read(registry, applyScanChangeAtom)
    expect(registry.get(scanStateAtom)).toMatchObject({
      hydrated: true,
      scanning: true,
      stage: 'parse',
      progress: [{ provider: 'new', processed: 1 }],
    })
  })

  it('does not erase progress that arrives while a reconnect snapshot is hydrating', async () => {
    let resolve!: (value: { scanned: true; metadata: typeof metadata }) => void
    const status = vi.fn(() =>
      Effect.promise(
        () =>
          new Promise<{ scanned: true; metadata: typeof metadata }>(done => {
            resolve = done
          }),
      ),
    )
    const { registry, scanStateAtom, scanProgressAtom, rehydrateScanAtom } = setup({ status })
    const pending = run(registry, rehydrateScanAtom)
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    registry.set(scanProgressAtom, { stage: 'parse', provider: 'current', processed: 2 })
    resolve({ scanned: true, metadata })
    await pending
    expect(registry.get(scanStateAtom)).toMatchObject({
      scanning: true,
      progress: [{ provider: 'current', processed: 2 }],
    })
  })

  it('fences old-generation status reads after replacement metadata is applied', async () => {
    let resolveOld!: (value: { scanned: false }) => void
    const status = vi.fn(() => Effect.promise(() => new Promise<{ scanned: false }>(resolve => (resolveOld = resolve))))
    const {
      registry,
      scanStateAtom,
      scanHydrationStateAtom,
      resetScanMetadataAtom,
      applyStoreMetadataAtom,
      rehydrateScanAtom,
    } = setup({
      status,
      active: () => Effect.succeed(true),
    })
    const oldHydration = run(registry, rehydrateScanAtom)
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1))

    registry.set(resetScanMetadataAtom, undefined)
    registry.set(applyStoreMetadataAtom, {
      ...metadata,
      perProvider: [{ provider: 'new', ported: 0, unchanged: 0, failed: 0, unparsed: 8 }],
    })
    resolveOld({ scanned: false })
    await expect(oldHydration).resolves.toBe('failed')

    expect(registry.get(scanHydrationStateAtom)).toBe('scanned')
    expect(registry.get(scanStateAtom)).toMatchObject({ hydrated: true, scanning: false, unparsedTotal: 8 })
  })

  it('keeps completed scan metadata when its event overtakes the activity read', async () => {
    let resolveActive!: (value: boolean) => void
    const active = vi.fn(() =>
      Effect.promise(
        () =>
          new Promise<boolean>(resolve => {
            resolveActive = resolve
          }),
      ),
    )
    const { registry, rehydrateScanAtom, applyStoreMetadataAtom, scanStateAtom, scanHydrationStateAtom } = setup({
      status: () => Effect.succeed({ scanned: false }),
      active,
    })
    const hydration = run(registry, rehydrateScanAtom)
    await vi.waitFor(() => expect(active).toHaveBeenCalledOnce())
    registry.set(applyStoreMetadataAtom, metadata)
    resolveActive(false)
    await expect(hydration).resolves.toBe('scanned')
    expect(registry.get(scanHydrationStateAtom)).toBe('scanned')
    expect(registry.get(scanStateAtom)).toMatchObject({ hydrated: true, scanning: false })
  })

  it('applies StoreChanged metadata immediately and hydrates providers independently', async () => {
    const status = vi.fn(() => Effect.succeed({ scanned: true, metadata }))
    let resolveAnalytics!: (value: {
      providers: { name: string; cost: number; calls: number; sessions: number }[]
      models: []
      categories: []
      skills: []
      subagents: []
    }) => void
    const analytics = vi.fn(() =>
      Effect.promise(
        () =>
          new Promise<{
            providers: { name: string; cost: number; calls: number; sessions: number }[]
            models: []
            categories: []
            skills: []
            subagents: []
          }>(done => {
            resolveAnalytics = done
          }),
      ),
    )
    const { registry, applyStoreMetadataAtom, hydrateScanProvidersAtom, scanStateAtom } = setup({ status, analytics })
    const unmount = registry.mount(hydrateScanProvidersAtom)
    registry.set(applyStoreMetadataAtom, metadata)
    expect(status).not.toHaveBeenCalled()
    expect(registry.get(scanStateAtom)).toMatchObject({ hydrated: true, unparsedTotal: 0 })
    await vi.waitFor(() => expect(analytics).toHaveBeenCalledTimes(1))
    expect(registry.get(scanStateAtom).detectedProviders).toEqual([])
    resolveAnalytics({
      providers: [{ name: 'codex', cost: 1, calls: 1, sessions: 1 }],
      models: [],
      categories: [],
      skills: [],
      subagents: [],
    })
    await vi.waitFor(() => expect(registry.get(scanStateAtom).detectedProviders).toEqual(['codex']))
    unmount()
  })

  it('admits one scan command and keeps its guard when repeated requests are refused', async () => {
    let resolve!: (value: { ok: true }) => void
    const scan = vi.fn(() =>
      Effect.promise(
        () =>
          new Promise<{ ok: true }>(done => {
            resolve = done
          }),
      ),
    )
    const { registry, refreshScanAtom } = setup({ scan })
    const unmount = registry.mount(refreshScanAtom)
    registry.set(refreshScanAtom, undefined)
    await vi.waitFor(() => expect(scan).toHaveBeenCalledTimes(1))
    registry.set(refreshScanAtom, undefined)
    await Promise.resolve()
    registry.set(refreshScanAtom, undefined)
    await Promise.resolve()
    expect(scan).toHaveBeenCalledTimes(1)
    resolve({ ok: true })
    await read(registry, refreshScanAtom)
    unmount()
  })

  it('hydrates once and adopts an already running scan', async () => {
    const getScanStatus = vi.fn(() => Effect.succeed({ scanned: false }))
    const { registry, rehydrateScanAtom, scanStateAtom } = setup({
      status: getScanStatus,
      active: () => Effect.succeed(true),
    })
    await expect(run(registry, rehydrateScanAtom)).resolves.toBe('unscanned')
    expect(getScanStatus).toHaveBeenCalledTimes(1)
    expect(registry.get(scanStateAtom)).toMatchObject({ hydrated: false, scanning: true })
  })
})
