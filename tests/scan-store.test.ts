import * as Effect from 'effect/Effect'
import type * as AsyncResult from 'effect/reactivity/AsyncResult'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createScanAtoms } from '../src/renderer/stores/atoms/scan.js'
import type { ScanResult, ScanStatus } from '../src/shared/schemas/ipc.js'
import type { AnalyticalViews } from '../src/shared/schemas/views.js'
import { makeScanRpcTestClient, type ScanRpcTestOverrides } from './scan-rpc-test-helper.js'

/** Stub the preload surface for the fetch wrappers' IPC-call sites. The real
 * preload exposes `platform` inside the `api` object (preload/index.ts). */
function mockWindow(api: unknown, platform = 'win32'): void {
  ;(globalThis as { window?: unknown }).window = {
    api: { ...(api as Record<string, unknown>), platform },
  }
  const methods = api as {
    getScanStatus?: () => Promise<ScanStatus>
    getAnalytics?: () => Promise<AnalyticalViews | null>
    getScanActive?: () => Promise<boolean>
    scan?: () => Promise<ScanResult>
  }
  const status = methods.getScanStatus
  if (status) overrides.status = () => Effect.tryPromise({ try: status, catch: error => error })
  const analytics = methods.getAnalytics
  if (analytics) overrides.analytics = () => Effect.tryPromise({ try: analytics, catch: error => error })
  const active = methods.getScanActive
  if (active) overrides.active = () => Effect.tryPromise({ try: active, catch: error => error })
  const scan = methods.scan
  if (scan) overrides.scan = () => Effect.tryPromise({ try: scan, catch: error => error })
}

const statusScanned = {
  scanned: true,
  metadata: {
    scanId: 'scan-1',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:00:01Z',
    portedFiles: 1,
    unchangedFiles: 0,
    failedFiles: 0,
    perProvider: [{ provider: 'openai', ported: 1, unchanged: 0, failed: 0, unparsed: 3 }],
    aborted: false,
  },
}

/** A darwin zero-source scan — the macOS Full Disk Access signal (ADR 0015). */
const statusEmptyDarwin = {
  scanned: true,
  metadata: {
    scanId: 'scan-empty',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:00:01Z',
    portedFiles: 0,
    unchangedFiles: 0,
    failedFiles: 0,
    perProvider: [],
    aborted: false,
  },
}

const analytics = {
  providers: [{ name: 'openai', cost: 1, calls: 2, sessions: 3 }],
  models: [],
  categories: [],
  skills: [],
  subagents: [],
}

let registry: AtomRegistry.AtomRegistry
let atoms: ReturnType<typeof createScanAtoms>
let overrides: ScanRpcTestOverrides
beforeEach(() => {
  registry = AtomRegistry.make()
  overrides = {}
  const runtime = Atom.context()
  atoms = createScanAtoms(makeScanRpcTestClient(runtime, overrides), runtime)
})
afterEach(() => {
  registry.dispose()
  vi.unstubAllGlobals()
})
function read<A, E>(atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>): Promise<A> {
  return Effect.runPromise(AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }))
}
function run<A, E>(atom: Atom.AtomResultFn<undefined, A, E>): Promise<A> {
  registry.set(atom, undefined)
  return read(atom)
}

describe('native scan lifecycle (ADR 0011)', () => {
  it('starts unhydrated and idle', () => {
    const s = registry.get(atoms.scanStateAtom)
    expect(s.hydrated).toBe(false)
    expect(s.scanning).toBe(false)
    expect(s.scanError).toBeNull()
    expect(s.progress).toEqual([])
    expect(s.detectedProviders).toEqual([])
  })

  it('onProgress upserts the per-provider entry and marks scanning', () => {
    registry.set(atoms.scanProgressAtom, { stage: 'parse', provider: 'openai', processed: 10 })
    registry.set(atoms.scanProgressAtom, { stage: 'parse', provider: 'cursor', processed: 5 })
    registry.set(atoms.scanProgressAtom, { stage: 'parse', provider: 'openai', processed: 40 })
    const s = registry.get(atoms.scanStateAtom)
    expect(s.scanning).toBe(true)
    expect(s.progress).toHaveLength(2)
    expect(s.progress.find(p => p.provider === 'openai')).toEqual({
      provider: 'openai',
      processed: 40,
      done: false,
    })
  })

  it('onProgress settles a provider on its port-in event', () => {
    registry.set(atoms.scanProgressAtom, { stage: 'port-in', provider: 'openai', processed: 100 })
    expect(registry.get(atoms.scanStateAtom).progress[0]?.done).toBe(true)
  })

  it('onProgress with no provider only marks scanning (parity with AppRoot)', () => {
    registry.set(atoms.scanProgressAtom, { stage: 'pricing' })
    const s = registry.get(atoms.scanStateAtom)
    expect(s.scanning).toBe(true)
    expect(s.progress).toEqual([])
  })

  it('onProgress keeps insertion order and only moves the stage forward', () => {
    registry.set(atoms.scanProgressAtom, { stage: 'pricing' })
    expect(registry.get(atoms.scanStateAtom).stage).toBe('pricing')
    registry.set(atoms.scanProgressAtom, { stage: 'parse', provider: 'openai', processed: 1 })
    registry.set(atoms.scanProgressAtom, { stage: 'parse', provider: 'cursor', processed: 1 })
    registry.set(atoms.scanProgressAtom, { stage: 'port-in', provider: 'openai', processed: 10 })
    registry.set(atoms.scanProgressAtom, { stage: 'parse', provider: 'cursor', processed: 20 })
    const s = registry.get(atoms.scanStateAtom)
    expect(s.progress.map(p => p.provider)).toEqual(['openai', 'cursor'])
    expect(s.stage).toBe('port-in')
  })

  it('onError surfaces the message and stops scanning', () => {
    registry.set(atoms.scanErrorAtom, 'boom')
    const s = registry.get(atoms.scanStateAtom)
    expect(s.scanError).toBe('boom')
    expect(s.scanning).toBe(false)
  })

  it('onIdle clears the non-blocking progress indicator', () => {
    registry.set(atoms.scanProgressAtom, { stage: 'parse', provider: 'openai', processed: 1 })
    registry.set(atoms.scanIdleAtom, undefined)
    const s = registry.get(atoms.scanStateAtom)
    expect(s.scanning).toBe(false)
    expect(s.progress).toEqual([])
    expect(s.stage).toBeNull()
  })

  it('applyChange hydrates, sums unparsed, loads providers and clears completed activity', async () => {
    mockWindow({
      getScanStatus: () => Promise.resolve(statusScanned),
      getAnalytics: () => Promise.resolve(analytics),
    })

    const unmount = registry.mount(atoms.hydrateScanProvidersAtom)
    await run(atoms.applyScanChangeAtom)
    await vi.waitFor(() => expect(registry.get(atoms.scanStateAtom).detectedProviders).toEqual(['openai']))

    const s = registry.get(atoms.scanStateAtom)
    expect(s.hydrated).toBe(true)
    expect(s.unparsedTotal).toBe(3)
    expect(s.detectedProviders).toEqual(['openai'])
    expect(s.scanning).toBe(false)
    expect(s.progress).toEqual([])
    unmount()
  })

  it('applyChange with an unscanned status does not hydrate', async () => {
    mockWindow({
      getScanStatus: () => Promise.resolve({ scanned: false }),
      getAnalytics: () => Promise.resolve(analytics),
    })
    await run(atoms.applyScanChangeAtom)
    const s = registry.get(atoms.scanStateAtom)
    expect(s.hydrated).toBe(false)
  })

  it('applyChange clears detected providers when analytics fails (parity with AppRoot)', async () => {
    registry.set(atoms.scanStateAtom, { ...registry.get(atoms.scanStateAtom), detectedProviders: ['openai'] })
    mockWindow({
      getScanStatus: () => Promise.resolve(statusScanned),
      getAnalytics: () => Promise.resolve({ ok: false, error: 'analytics unavailable' }),
    })
    const unmount = registry.mount(atoms.hydrateScanProvidersAtom)
    await run(atoms.applyScanChangeAtom)
    await vi.waitFor(() => expect(registry.get(atoms.scanStateAtom).detectedProviders).toEqual([]))
    expect(registry.get(atoms.scanStateAtom).detectedProviders).toEqual([])
    expect(registry.get(atoms.scanStateAtom).hydrated).toBe(true)
    unmount()
  })

  it('applyChange surfaces a schema-invalid scan status', async () => {
    mockWindow({ getScanStatus: () => Promise.resolve({ scanned: 'yes' }) })
    await run(atoms.applyScanChangeAtom)
    const s = registry.get(atoms.scanStateAtom)
    expect(s.hydrated).toBe(false)
    expect(s.scanError).toBe('Configuration command failed')
  })

  it('flags fdaNeeded on macOS when the last scan found zero sources (ADR 0015)', async () => {
    mockWindow({ getScanStatus: () => Promise.resolve(statusEmptyDarwin) }, 'darwin')
    await run(atoms.applyScanChangeAtom)
    expect(registry.get(atoms.scanStateAtom).fdaNeeded).toBe(true)
  })

  it('never flags fdaNeeded on macOS when a scan found data', async () => {
    mockWindow({ getScanStatus: () => Promise.resolve(statusScanned) }, 'darwin')
    await run(atoms.applyScanChangeAtom)
    expect(registry.get(atoms.scanStateAtom).fdaNeeded).toBe(false)
  })

  it('never flags fdaNeeded on non-macOS platforms, even for zero-source scans', async () => {
    mockWindow({ getScanStatus: () => Promise.resolve(statusEmptyDarwin) }, 'win32')
    await run(atoms.applyScanChangeAtom)
    expect(registry.get(atoms.scanStateAtom).fdaNeeded).toBe(false)
  })

  it('refresh failure surfaces the error and stops scanning', async () => {
    mockWindow({ scan: () => Promise.resolve({ ok: false, error: 'provider unreadable' }) })
    await run(atoms.refreshScanAtom)
    const s = registry.get(atoms.scanStateAtom)
    expect(s.scanError).toBe('provider unreadable')
    expect(s.scanning).toBe(false)
  })

  it('refresh falls back to the generic failure message when the main gives none', async () => {
    mockWindow({ scan: () => Promise.resolve({ ok: false }) })
    await run(atoms.refreshScanAtom)
    expect(registry.get(atoms.scanStateAtom).scanError).toBe('Scan failed. Check your provider sources and try again.')
  })

  it('refresh keeps scanning when a scan is already running', async () => {
    mockWindow({ scan: () => Promise.resolve({ ok: false, alreadyRunning: true }) })
    await run(atoms.refreshScanAtom)
    const s = registry.get(atoms.scanStateAtom)
    expect(s.scanning).toBe(true)
    expect(s.scanError).toBeNull()
  })

  it('refresh never surfaces an aborted scan as an error', async () => {
    mockWindow({ scan: () => Promise.resolve({ ok: false, aborted: true }) })
    registry.set(atoms.scanProgressAtom, { stage: 'parse', provider: 'openai', processed: 1 })
    await run(atoms.refreshScanAtom)
    const s = registry.get(atoms.scanStateAtom)
    expect(s.scanning).toBe(true)
    expect(s.scanError).toBeNull()
  })

  it('refresh surfaces a schema-invalid scan result as an error', async () => {
    mockWindow({ scan: () => Promise.resolve({ ok: 'maybe' }) })
    await run(atoms.refreshScanAtom)
    const s = registry.get(atoms.scanStateAtom)
    expect(s.scanning).toBe(false)
    expect(s.scanError).toBeNull()
  })

  it('syncActivity adopts a scan already in flight in the main process', async () => {
    mockWindow({ getScanActive: vi.fn(async () => true) })
    await run(atoms.syncActivityAtom)
    expect(registry.get(atoms.scanStateAtom).scanning).toBe(true)
  })

  it('syncActivity leaves an idle store idle', async () => {
    mockWindow({ getScanActive: vi.fn(async () => false) })
    await run(atoms.syncActivityAtom)
    expect(registry.get(atoms.scanStateAtom).scanning).toBe(false)
  })

  it('hydrate: a ledger loads metadata and adopts a scan in flight', async () => {
    mockWindow({
      getScanStatus: vi.fn(async () => statusScanned),
      getAnalytics: vi.fn(async () => null),
      getScanActive: vi.fn(async () => true),
    })
    await expect(run(atoms.rehydrateScanAtom)).resolves.toBe('scanned')
    expect(registry.get(atoms.scanStateAtom).hydrated).toBe(true)
    expect(registry.get(atoms.scanStateAtom).scanning).toBe(true)
  })

  it('hydrate: no ledger yet reports unscanned (the app window fires the first scan)', async () => {
    const getScanActive = vi.fn(async () => true)
    mockWindow({ getScanStatus: vi.fn(async () => ({ scanned: false })), getScanActive })
    await expect(run(atoms.rehydrateScanAtom)).resolves.toBe('unscanned')
    expect(registry.get(atoms.scanStateAtom).hydrated).toBe(false)
    // Another window's first scan already running still shows here.
    expect(getScanActive).toHaveBeenCalled()
    expect(registry.get(atoms.scanStateAtom).scanning).toBe(true)
  })

  it('hydrate: an unreadable status reports failed and touches nothing', async () => {
    const getScanActive = vi.fn(async () => true)
    mockWindow({ getScanStatus: vi.fn(async () => ({ bogus: 1 })), getScanActive })
    await expect(run(atoms.rehydrateScanAtom)).resolves.toBe('failed')
    expect(getScanActive).not.toHaveBeenCalled()
  })
})
