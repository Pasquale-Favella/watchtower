import * as Effect from 'effect/Effect'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createScanAtoms } from '../src/renderer/stores/atoms/scan.js'
import { bootstrapInitialScan, shouldStartInitialScan } from '../src/renderer/stores/hooks/use-app-bootstrap.js'
import { makeScanRpcTestClient } from './scan-rpc-test-helper.js'

const metadata = {
  scanId: 'scan',
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:00:01Z',
  portedFiles: 1,
  unchangedFiles: 0,
  failedFiles: 0,
  perProvider: [{ provider: 'codex', ported: 1, unchanged: 0, failed: 0, unparsed: 2 }],
  aborted: false,
}

function run<A, E>(registry: AtomRegistry.AtomRegistry, atom: Atom.AtomResultFn<undefined, A, E>): Promise<A> {
  registry.set(atom, undefined)
  return Effect.runPromise(
    AtomRegistry.getResult(registry, atom as Atom.Atom<import('effect/reactivity/AsyncResult').AsyncResult<A, E>>, {
      suspendOnWaiting: true,
    }),
  )
}

describe('renderer bootstrap scan admission', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('waits for native events, then starts one scan after the cold snapshot', async () => {
    const registry = AtomRegistry.make()
    vi.stubGlobal('window', { api: { platform: 'win32' } })
    let resolveScan!: (value: { ok: true }) => void
    const scan = vi.fn(() =>
      Effect.promise(
        () =>
          new Promise<{ ok: true }>(resolve => {
            resolveScan = resolve
          }),
      ),
    )
    const scanStatus = vi.fn(() => Effect.succeed({ scanned: false }))
    const client = makeScanRpcTestClient(Atom.context(), {
      status: scanStatus,
      active: () => Effect.succeed(false),
      scan,
    })
    const atoms = createScanAtoms(client, Atom.context())
    const order: string[] = []
    const bootstrap = bootstrapInitialScan(
      Effect.sync(() => {
        order.push('events-ready')
      }),
      Effect.tryPromise({ try: () => run(registry, atoms.rehydrateScanAtom), catch: error => error }),
      () => registry.get(atoms.scanStateAtom).scanning,
      () => Effect.tryPromise({ try: () => run(registry, atoms.refreshScanAtom), catch: error => error }),
    )

    const pending = Effect.runPromise(bootstrap)
    await vi.waitFor(() => expect(scan).toHaveBeenCalledOnce())
    expect(order).toEqual(['events-ready'])
    expect(scanStatus).toHaveBeenCalledOnce()

    registry.set(atoms.scanProgressAtom, { stage: 'parse', provider: 'codex', processed: 1 })
    registry.set(atoms.applyStoreMetadataAtom, metadata)
    expect(registry.get(atoms.scanStateAtom)).toMatchObject({ hydrated: true, unparsedTotal: 2 })

    resolveScan({ ok: true })
    await pending
    expect(registry.get(atoms.scanStateAtom)).toMatchObject({ hydrated: true, scanning: false })
    registry.dispose()
    vi.unstubAllGlobals()
  })

  it('does not start a scan when status is unscanned but scan activity cannot be confirmed', async () => {
    const registry = AtomRegistry.make()
    vi.stubGlobal('window', { api: { platform: 'win32' } })
    const runtime = Atom.context()
    const startScan = vi.fn(() => Effect.succeed(undefined))
    const client = makeScanRpcTestClient(runtime, {
      status: () => Effect.succeed({ scanned: false }),
      active: () => Effect.fail(new Error('activity transport unavailable')),
    })
    const atoms = createScanAtoms(client, runtime)
    const hydration = await run(registry, atoms.rehydrateScanAtom)

    await Effect.runPromise(
      bootstrapInitialScan(
        Effect.void,
        Effect.succeed(hydration),
        () => registry.get(atoms.scanStateAtom).scanning,
        startScan,
      ),
    )

    expect(hydration).toBe('failed')
    expect(registry.get(atoms.scanHydrationStateAtom)).toBe('failed')
    expect(registry.get(atoms.scanStateAtom).scanning).toBe(false)
    expect(registry.get(atoms.scanStateAtom).scanError).toBeTruthy()
    expect(startScan).not.toHaveBeenCalled()
    registry.dispose()
  })

  it('does not start a duplicate scan when the worker confirms one is active', async () => {
    const registry = AtomRegistry.make()
    vi.stubGlobal('window', { api: { platform: 'win32' } })
    const runtime = Atom.context()
    const startScan = vi.fn(() => Effect.succeed(undefined))
    const client = makeScanRpcTestClient(runtime, {
      status: () => Effect.succeed({ scanned: false }),
      active: () => Effect.succeed(true),
    })
    const atoms = createScanAtoms(client, runtime)
    const hydration = await run(registry, atoms.rehydrateScanAtom)

    await Effect.runPromise(
      bootstrapInitialScan(
        Effect.void,
        Effect.succeed(hydration),
        () => registry.get(atoms.scanStateAtom).scanning,
        startScan,
      ),
    )

    expect(hydration).toBe('unscanned')
    expect(registry.get(atoms.scanStateAtom).scanning).toBe(true)
    expect(startScan).not.toHaveBeenCalled()
    registry.dispose()
  })

  it('starts a first scan only for a confirmed unscanned idle ledger', () => {
    expect(shouldStartInitialScan('pending', false)).toBe(false)
    expect(shouldStartInitialScan('failed', false)).toBe(false)
    expect(shouldStartInitialScan('scanned', false)).toBe(false)
    expect(shouldStartInitialScan('unscanned', false)).toBe(true)
    expect(shouldStartInitialScan('unscanned', true)).toBe(false)
  })
})
