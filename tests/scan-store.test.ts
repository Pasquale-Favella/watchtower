import { beforeEach, describe, expect, it, vi } from 'vitest'

import { subscribeToRefresh, useScanStore } from '../src/renderer/src/app/stores/scan-store.js'

/** Stub the preload surface for the fetch wrappers' IPC-call sites. The real
 * preload exposes `platform` inside the `api` object (preload/index.ts). */
function mockWindow(api: unknown, platform = 'win32'): void {
  ;(globalThis as { window?: unknown }).window = {
    api: { ...(api as Record<string, unknown>), platform },
  }
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

beforeEach(() => {
  useScanStore.setState(useScanStore.getInitialState(), true)
})

describe('useScanStore scan lifecycle (ADR 0011)', () => {
  it('starts unhydrated and idle', () => {
    const s = useScanStore.getState()
    expect(s.hydrated).toBe(false)
    expect(s.scanning).toBe(false)
    expect(s.scanError).toBeNull()
    expect(s.refreshVersion).toBe(0)
    expect(s.progress).toEqual([])
    expect(s.detectedProviders).toEqual([])
  })

  it('onProgress upserts the per-provider entry and marks scanning', () => {
    useScanStore.getState().onProgress('openai', 10, 100, false)
    useScanStore.getState().onProgress('cursor', 5, 50, false)
    useScanStore.getState().onProgress('openai', 40, 100, false)
    const s = useScanStore.getState()
    expect(s.scanning).toBe(true)
    expect(s.progress).toHaveLength(2)
    expect(s.progress.find(p => p.provider === 'openai')).toEqual({
      provider: 'openai',
      processed: 40,
      total: 100,
      done: false,
    })
  })

  it('onProgress marks a port-in stage as done', () => {
    useScanStore.getState().onProgress('openai', 100, 100, true)
    expect(useScanStore.getState().progress[0]!.done).toBe(true)
  })

  it('onProgress with no provider only marks scanning (parity with AppRoot)', () => {
    useScanStore.getState().onProgress('', 0, 0, false)
    const s = useScanStore.getState()
    expect(s.scanning).toBe(true)
    expect(s.progress).toEqual([])
  })

  it('onError surfaces the message and stops scanning', () => {
    useScanStore.getState().onError('boom')
    const s = useScanStore.getState()
    expect(s.scanError).toBe('boom')
    expect(s.scanning).toBe(false)
  })

  it('onIdle clears the non-blocking progress indicator', () => {
    useScanStore.getState().onProgress('openai', 1, 1, false)
    useScanStore.getState().onIdle()
    const s = useScanStore.getState()
    expect(s.scanning).toBe(false)
    expect(s.progress).toEqual([])
  })

  it('applyChange hydrates, sums unparsed, loads providers and bumps the shared tick', async () => {
    mockWindow({
      getScanStatus: () => Promise.resolve(statusScanned),
      getAnalytics: () => Promise.resolve(analytics),
    })
    const reload = vi.fn()
    subscribeToRefresh(reload)

    await useScanStore.getState().applyChange()

    const s = useScanStore.getState()
    expect(s.hydrated).toBe(true)
    expect(s.unparsedTotal).toBe(3)
    expect(s.detectedProviders).toEqual(['openai'])
    expect(s.scanning).toBe(false)
    expect(s.progress).toEqual([])
    expect(s.refreshVersion).toBe(1)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('applyChange with an unscanned status does not hydrate', async () => {
    mockWindow({
      getScanStatus: () => Promise.resolve({ scanned: false }),
      getAnalytics: () => Promise.resolve(analytics),
    })
    await useScanStore.getState().applyChange()
    const s = useScanStore.getState()
    expect(s.hydrated).toBe(false)
    expect(s.refreshVersion).toBe(1)
  })

  it('applyChange clears detected providers when analytics fails (parity with AppRoot)', async () => {
    useScanStore.setState({ detectedProviders: ['openai'] })
    mockWindow({
      getScanStatus: () => Promise.resolve(statusScanned),
      getAnalytics: () => Promise.resolve({ ok: false, error: 'analytics unavailable' }),
    })
    await useScanStore.getState().applyChange()
    expect(useScanStore.getState().detectedProviders).toEqual([])
    expect(useScanStore.getState().hydrated).toBe(true)
  })

  it('applyChange with a schema-invalid scan status is a no-op', async () => {
    mockWindow({ getScanStatus: () => Promise.resolve({ scanned: 'yes' }) })
    await useScanStore.getState().applyChange()
    const s = useScanStore.getState()
    expect(s.hydrated).toBe(false)
    expect(s.refreshVersion).toBe(0)
  })

  it('flags fdaNeeded on macOS when the last scan found zero sources (ADR 0015)', async () => {
    mockWindow({ getScanStatus: () => Promise.resolve(statusEmptyDarwin) }, 'darwin')
    await useScanStore.getState().applyChange()
    expect(useScanStore.getState().fdaNeeded).toBe(true)
  })

  it('never flags fdaNeeded on macOS when a scan found data', async () => {
    mockWindow({ getScanStatus: () => Promise.resolve(statusScanned) }, 'darwin')
    await useScanStore.getState().applyChange()
    expect(useScanStore.getState().fdaNeeded).toBe(false)
  })

  it('never flags fdaNeeded on non-macOS platforms, even for zero-source scans', async () => {
    mockWindow({ getScanStatus: () => Promise.resolve(statusEmptyDarwin) }, 'win32')
    await useScanStore.getState().applyChange()
    expect(useScanStore.getState().fdaNeeded).toBe(false)
  })

  it('refresh failure surfaces the error and stops scanning', async () => {
    mockWindow({ scan: () => Promise.resolve({ ok: false, error: 'provider unreadable' }) })
    await useScanStore.getState().refresh()
    const s = useScanStore.getState()
    expect(s.scanError).toBe('provider unreadable')
    expect(s.scanning).toBe(false)
  })

  it('refresh falls back to the generic failure message when the main gives none', async () => {
    mockWindow({ scan: () => Promise.resolve({ ok: false }) })
    await useScanStore.getState().refresh()
    expect(useScanStore.getState().scanError).toBe('Scan failed. Check your provider sources and try again.')
  })

  it('refresh keeps scanning when a scan is already running', async () => {
    mockWindow({ scan: () => Promise.resolve({ ok: true, alreadyRunning: true }) })
    await useScanStore.getState().refresh()
    const s = useScanStore.getState()
    expect(s.scanning).toBe(true)
    expect(s.scanError).toBeNull()
  })

  it('refresh never surfaces an aborted scan as an error', async () => {
    mockWindow({ scan: () => Promise.resolve({ ok: false, aborted: true }) })
    await useScanStore.getState().refresh()
    const s = useScanStore.getState()
    expect(s.scanning).toBe(true)
    expect(s.scanError).toBeNull()
  })

  it('refresh surfaces a schema-invalid scan result as an error', async () => {
    mockWindow({ scan: () => Promise.resolve({ ok: 'maybe' }) })
    await useScanStore.getState().refresh()
    const s = useScanStore.getState()
    expect(s.scanning).toBe(false)
    expect(s.scanError).toMatch(/Invalid scan payload/)
  })

  it('syncActivity adopts a scan already in flight in the main process', async () => {
    mockWindow({ getScanActive: vi.fn(async () => true) })
    await useScanStore.getState().syncActivity()
    expect(useScanStore.getState().scanning).toBe(true)
  })

  it('syncActivity leaves an idle store idle', async () => {
    mockWindow({ getScanActive: vi.fn(async () => false) })
    await useScanStore.getState().syncActivity()
    expect(useScanStore.getState().scanning).toBe(false)
  })

  it('hydrate: a ledger applies the change path and adopts a scan in flight', async () => {
    mockWindow({
      getScanStatus: vi.fn(async () => statusScanned),
      getAnalytics: vi.fn(async () => null),
      getScanActive: vi.fn(async () => true),
    })
    await expect(useScanStore.getState().hydrate()).resolves.toBe('scanned')
    expect(useScanStore.getState().hydrated).toBe(true)
    expect(useScanStore.getState().scanning).toBe(true)
  })

  it('hydrate: no ledger yet reports unscanned (the app window fires the first scan)', async () => {
    const getScanActive = vi.fn(async () => true)
    mockWindow({ getScanStatus: vi.fn(async () => ({ scanned: false })), getScanActive })
    await expect(useScanStore.getState().hydrate()).resolves.toBe('unscanned')
    expect(useScanStore.getState().hydrated).toBe(false)
    // Another window's first scan already running still shows here.
    expect(getScanActive).toHaveBeenCalled()
    expect(useScanStore.getState().scanning).toBe(true)
  })

  it('hydrate: an unreadable status reports failed and touches nothing', async () => {
    const getScanActive = vi.fn(async () => true)
    mockWindow({ getScanStatus: vi.fn(async () => ({ bogus: 1 })), getScanActive })
    await expect(useScanStore.getState().hydrate()).resolves.toBe('failed')
    expect(getScanActive).not.toHaveBeenCalled()
  })
})
