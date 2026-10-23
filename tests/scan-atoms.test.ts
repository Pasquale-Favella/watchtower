import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createRemoteQuerySlot } from '../src/renderer/src/app/atoms/remote-query.js'
import { createScanAtoms } from '../src/renderer/src/app/atoms/scan.js'
import { legacyRendererApi, RendererApi, RendererApiError } from '../src/renderer/src/shared/lib/renderer-api.js'

const registries: AtomRegistry.AtomRegistry[] = []
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose()
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

function setup(overrides: Partial<RendererApi['Service']> = {}) {
  const registry = AtomRegistry.make()
  registries.push(registry)
  const factory = Atom.context()
  const layer = Layer.succeed(RendererApi, {
    ...legacyRendererApi,
    getPlatform: () => Effect.succeed('darwin'),
    getScanStatus: () => Effect.succeed({ scanned: true, metadata }),
    getAnalytics: () => Effect.succeed(null),
    getScanActive: () => Effect.succeed(false),
    ...overrides,
  })
  const atoms = createScanAtoms(factory, layer)
  return { registry, factory, layer, ...atoms }
}

function read<A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<import('effect/reactivity/AsyncResult').AsyncResult<A, E>>,
) {
  return Effect.runPromise(AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }))
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
    const { registry, factory, layer, applyScanChangeAtom, scanStateAtom, scanProgressAtom } = setup({
      getScanStatus: () => Effect.fail(new RendererApiError({ operation: 'status', message: 'unavailable' })),
    })
    let calls = 0
    const query = createRemoteQuerySlot({
      runtime: factory(layer),
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
    expect(registry.get(scanStateAtom)).toMatchObject({ scanError: 'unavailable', scanning: false })
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

  it('ignores an older config snapshot after scan completion has hydrated newer state', async () => {
    let resolve!: (value: { scanned: false }) => void
    const getScanStatus = vi
      .fn()
      .mockReturnValueOnce(
        Effect.promise(
          () =>
            new Promise<{ scanned: false }>(done => {
              resolve = done
            }),
        ),
      )
      .mockReturnValueOnce(Effect.succeed({ scanned: true, metadata }))
    const { registry, scanStateAtom, applyConfigChangeAtom, applyScanChangeAtom } = setup({ getScanStatus })
    const releaseConfig = registry.mount(applyConfigChangeAtom)
    registry.set(applyConfigChangeAtom, undefined)
    await vi.waitFor(() => expect(getScanStatus).toHaveBeenCalledTimes(1))
    registry.set(applyScanChangeAtom, undefined)
    await read(registry, applyScanChangeAtom)
    resolve({ scanned: false })
    await read(registry, applyConfigChangeAtom)
    expect(registry.get(scanStateAtom).hydrated).toBe(true)
    releaseConfig()
  })

  it('hydrates metadata and the Full Disk Access signal while clearing failed provider reads', async () => {
    const { registry, scanStateAtom, applyScanChangeAtom } = setup()
    registry.set(scanStateAtom, { ...registry.get(scanStateAtom), detectedProviders: ['old'] })
    registry.set(applyScanChangeAtom, undefined)
    await read(registry, applyScanChangeAtom)
    expect(registry.get(scanStateAtom)).toMatchObject({
      hydrated: true,
      fdaNeeded: true,
      detectedProviders: [],
    })
  })

  it('does not erase new scan progress with an older metadata response', async () => {
    let resolve!: (value: { scanned: boolean; metadata: typeof metadata }) => void
    const { registry, scanStateAtom, scanProgressAtom, applyScanChangeAtom } = setup({
      getScanStatus: () =>
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

  it('shares one boot hydration and adopts an already running scan', async () => {
    const getScanStatus = vi.fn(() => Effect.succeed({ scanned: false }))
    const { registry, hydrateScanAtom, scanStateAtom } = setup({
      getScanStatus,
      getScanActive: () => Effect.succeed(true),
    })
    const result = await Promise.all([read(registry, hydrateScanAtom), read(registry, hydrateScanAtom)])
    expect(result).toEqual(['unscanned', 'unscanned'])
    expect(getScanStatus).toHaveBeenCalledTimes(1)
    expect(registry.get(scanStateAtom)).toMatchObject({ hydrated: false, scanning: true })
  })
})
