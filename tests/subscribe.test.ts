import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { configInvalidationRevisionAtom } from '../src/renderer/src/app/atoms/config-change.js'
import { initialScanState } from '../src/renderer/src/app/atoms/scan.js'
import { refreshScanAtom, scanProgressAtom, scanStateAtom } from '../src/renderer/src/app/atoms/scan.js'
import { setRouter } from '../src/renderer/src/app/navigation.js'
import { appEventsReadyAtom, subscribeToIpc } from '../src/renderer/src/app/stores/subscribe.js'
import { coachStateAtom } from '../src/renderer/src/features/coach-skills/atoms.js'
import { activeCurrencyAtom } from '../src/renderer/src/features/settings/atoms.js'
import { updatesMachineAtom } from '../src/renderer/src/features/settings/updates-atoms.js'

/** Stub the preload surface: capture each on* callback for manual firing,
 * merging any extra (fetch) methods onto the same `window.api`. */
function captureApi(extra?: Record<string, unknown>): Record<string, (payload?: unknown) => void> {
  const listeners: Record<string, (payload?: unknown) => void> = {}
  mockWindow({
    onProgress: (cb: (p: unknown) => void) => {
      listeners.onProgress = cb
      return () => {}
    },
    onError: (cb: (p: unknown) => void) => {
      listeners.onError = cb
      return () => {}
    },
    onChanged: (cb: (p: unknown) => void) => {
      listeners.onChanged = cb
      return () => {}
    },
    onIdle: (cb: () => void) => {
      listeners.onIdle = cb
      return () => {}
    },
    onCurrencyChanged: (cb: (p: unknown) => void) => {
      listeners.onCurrencyChanged = cb
      return () => {}
    },
    onConfigChanged: (cb: () => void) => {
      listeners.onConfigChanged = cb
      return () => {}
    },
    onCoachEvent: (cb: (p: unknown) => void) => {
      listeners.onCoachEvent = cb
      return () => {}
    },
    onCoachHarnessesChanged: (cb: (p: unknown) => void) => {
      listeners.onCoachHarnessesChanged = cb
      return () => {}
    },
    onUpdateChanged: (cb: (p: unknown) => void) => {
      listeners.onUpdateChanged = cb
      return () => {}
    },
    onNavigate: (cb: (p: unknown) => void) => {
      listeners.onNavigate = cb
      return () => {}
    },
    ...extra,
  })
  return listeners
}

function mockWindow(api: unknown): void {
  vi.stubGlobal('window', { api })
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

const storeChanged = {
  scanId: 'scan-1',
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:00:01Z',
  portedFiles: 1,
  unchangedFiles: 0,
  failedFiles: 0,
  perProvider: [{ provider: 'openai', ported: 1, unchanged: 0, failed: 0, unparsed: 3 }],
  aborted: false,
}

const analytics = {
  providers: [],
  models: [],
  categories: [],
  skills: [],
  subagents: [],
}

let registry: AtomRegistry.AtomRegistry
beforeEach(() => {
  registry = AtomRegistry.make()
  registry.set(updatesMachineAtom, { state: 'uninitialized' })
  registry.set(scanStateAtom, initialScanState())
  registry.set(activeCurrencyAtom, { code: 'USD', symbol: '$', rate: 1 })
})

afterEach(() => {
  registry.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('subscribeToIpc (ADR 0011)', () => {
  it('settles failed readiness and reconnects before a user retries a scan', async () => {
    captureApi({
      onNavigate: () => {
        throw new Error('bridge unavailable')
      },
    })
    const teardown = subscribeToIpc(registry)
    await vi.waitFor(() => expect(registry.get(appEventsReadyAtom)).toBe('failed'))
    expect(registry.get(scanStateAtom).scanError).toContain('Unable to subscribe')
    const scan = vi.fn(async () => ({ ok: true, alreadyRunning: true }))
    captureApi({ scan })
    registry.set(refreshScanAtom, undefined)
    await vi.waitFor(() => {
      expect(registry.get(appEventsReadyAtom)).toBe('ready')
      expect(scan).toHaveBeenCalledTimes(1)
    })
    teardown()
    await flushEvents()
  })
  it('routes validated update events into the app-owned store and drops malformed snapshots', async () => {
    const listeners = captureApi()
    const teardown = subscribeToIpc(registry)
    await flushEvents()
    const status = {
      revision: 1,
      currentVersion: '0.2.6',
      latestVersion: '0.3.0',
      updateAvailable: true,
      tag: 'v0.3.0',
      phase: 'available',
      installSupported: true,
      progress: null,
      message: null,
    }
    listeners.onUpdateChanged?.(status)
    await flushEvents()
    expect(registry.get(updatesMachineAtom)).toEqual({ state: 'synced', status })
    listeners.onUpdateChanged?.({ ...status, revision: -1 })
    await flushEvents()
    listeners.onUpdateChanged?.({ ...status, revision: 2, progress: 101 })
    await flushEvents()
    expect(registry.get(updatesMachineAtom)).toEqual({ state: 'synced', status })
    teardown()
    await flushEvents()
  })

  it('decodes Coach events and forwards only valid, stripped envelopes', async () => {
    const listeners = captureApi()
    registry.set(coachStateAtom, { ...registry.get(coachStateAtom), running: true })
    const notifyNotice = vi.fn(() => Promise.resolve())
    vi.stubGlobal('api', { notifyNotice })
    const teardown = subscribeToIpc(registry)
    await flushEvents()

    listeners.onCoachEvent!({
      runId: 'run-1',
      event: { kind: 'text', delta: 'Hello', extra: 'discarded' },
      extra: 'discarded',
    })
    await flushEvents()
    expect(registry.get(coachStateAtom).pendingEvents['run-1']).toEqual([
      { runId: 'run-1', event: { kind: 'text', delta: 'Hello' } },
    ])

    listeners.onCoachEvent!({ runId: 'run-1', event: { kind: 'text', delta: 42 } })
    await flushEvents()
    expect(registry.get(coachStateAtom).pendingEvents['run-1']).toHaveLength(1)
    expect(notifyNotice).toHaveBeenCalledWith('coach event', 'event.delta')
    teardown()
    await flushEvents()
  })
  it('feeds scan progress into the scan store, dropping malformed broadcasts', async () => {
    const listeners = captureApi()
    const teardown = subscribeToIpc(registry)
    await flushEvents()

    listeners.onProgress!({ stage: 'parse', provider: 'openai', processed: 5, total: 9 })
    await flushEvents()
    expect(registry.get(scanStateAtom).scanning).toBe(true)
    expect(registry.get(scanStateAtom).progress).toEqual([{ provider: 'openai', processed: 5, done: false }])

    listeners.onProgress!({ stage: 'port-in', provider: 'openai', processed: 9, total: 9 })
    await flushEvents()
    expect(registry.get(scanStateAtom).progress[0]!.done).toBe(true)

    listeners.onProgress!({ stage: 'nope' })
    await flushEvents()
    expect(registry.get(scanStateAtom).progress).toHaveLength(1)

    teardown()
    await flushEvents()
  })

  it('feeds scan errors and idle events into the scan store', async () => {
    const listeners = captureApi()
    const teardown = subscribeToIpc(registry)
    await flushEvents()

    listeners.onError!('boom')
    await flushEvents()
    expect(registry.get(scanStateAtom).scanError).toBe('boom')
    expect(registry.get(scanStateAtom).scanning).toBe(false)

    registry.set(scanProgressAtom, { stage: 'parse', provider: 'openai', processed: 1 })
    listeners.onIdle!()
    await flushEvents()
    expect(registry.get(scanStateAtom).scanning).toBe(false)
    expect(registry.get(scanStateAtom).progress).toEqual([])

    teardown()
    await flushEvents()
  })

  it('applies a store:changed broadcast through applyChange', async () => {
    const listeners = captureApi({
      getScanStatus: () => Promise.resolve(statusScanned),
      getAnalytics: () => Promise.resolve(analytics),
    })
    const teardown = subscribeToIpc(registry)
    await flushEvents()

    listeners.onChanged!(storeChanged)
    await flushEvents()
    await vi.waitFor(() => expect(registry.get(scanStateAtom).hydrated).toBe(true))
    expect(registry.get(scanStateAtom).unparsedTotal).toBe(3)

    teardown()
    await flushEvents()
  })

  it('drops a malformed store:changed broadcast', async () => {
    const getScanStatus = vi.fn(async () => statusScanned)
    const listeners = captureApi({ getScanStatus })
    const teardown = subscribeToIpc(registry)
    await flushEvents()
    listeners.onChanged!({ bogus: 1 })
    await flushEvents()
    expect(getScanStatus).not.toHaveBeenCalled()
    expect(registry.get(scanStateAtom).hydrated).toBe(false)
    teardown()
    await flushEvents()
  })

  it('leaves app config events to the native lifecycle subscription', async () => {
    const listeners = captureApi()
    const teardown = subscribeToIpc(registry)
    await flushEvents()

    expect(listeners.onConfigChanged).toBeUndefined()
    expect(registry.get(configInvalidationRevisionAtom)).toBe(0)

    teardown()
    await flushEvents()
  })

  it('feeds a currency:changed broadcast into the currency atom, dropping malformed ones', async () => {
    const notifyNotice = vi.fn<(label: string, location: string) => Promise<void>>(() => Promise.resolve())
    vi.stubGlobal('api', { notifyNotice })
    const listeners = captureApi()
    const teardown = subscribeToIpc(registry)
    await flushEvents()

    listeners.onCurrencyChanged!({ code: 'EUR', symbol: '€', rate: 0.9 })
    await flushEvents()
    expect(registry.get(activeCurrencyAtom)).toEqual({ code: 'EUR', symbol: '€', rate: 0.9 })

    listeners.onCurrencyChanged!({ code: 123 })
    await flushEvents()
    expect(registry.get(activeCurrencyAtom).code).toBe('EUR')
    expect(notifyNotice).toHaveBeenCalledWith('currency changed', 'code')
    expect(notifyNotice).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything())

    teardown()
    await flushEvents()
  })

  it('shares one ready subscription and cleans listeners after the last owner releases it', async () => {
    const unsub = vi.fn(() => {})
    const listeners: Record<string, (payload?: unknown) => void> = {}
    mockWindow({
      onProgress: (cb: (p: unknown) => void) => {
        listeners.onProgress = cb
        return unsub
      },
      onError: (cb: (p: unknown) => void) => {
        listeners.onError = cb
        return unsub
      },
      onChanged: (cb: (p: unknown) => void) => {
        listeners.onChanged = cb
        return unsub
      },
      onIdle: (cb: () => void) => {
        listeners.onIdle = cb
        return unsub
      },
      onCurrencyChanged: (cb: (p: unknown) => void) => {
        listeners.onCurrencyChanged = cb
        return unsub
      },
      onConfigChanged: (cb: () => void) => {
        listeners.onConfigChanged = cb
        return unsub
      },
      onCoachEvent: (cb: (p: unknown) => void) => {
        listeners.onCoachEvent = cb
        return unsub
      },
      onCoachHarnessesChanged: (cb: (p: unknown) => void) => {
        listeners.onCoachHarnessesChanged = cb
        return unsub
      },
      onUpdateChanged: (cb: (p: unknown) => void) => {
        listeners.onUpdateChanged = cb
        return unsub
      },
      onNavigate: (cb: (p: unknown) => void) => {
        listeners.onNavigate = cb
        return unsub
      },
    })
    const teardown = subscribeToIpc(registry)
    const releaseSecondOwner = subscribeToIpc(registry)
    await flushEvents()
    expect(registry.get(appEventsReadyAtom)).toBe('ready')
    expect(Object.keys(listeners)).toHaveLength(9)
    expect(listeners.onConfigChanged).toBeUndefined()
    teardown()
    await flushEvents()
    expect(unsub).not.toHaveBeenCalled()
    releaseSecondOwner()
    await flushEvents()
    expect(unsub).toHaveBeenCalledTimes(9)
  })

  it('feeds a coach:harnesses-changed broadcast into the coach store, dropping malformed ones', async () => {
    const listeners = captureApi()
    const teardown = subscribeToIpc(registry)
    await flushEvents()
    const row = {
      instanceId: 'codex',
      kind: 'codex',
      displayName: 'Codex',
      status: 'ready',
      auth: { status: 'configured' },
    }

    listeners.onCoachHarnessesChanged!([{ bogus: 1 }])
    await flushEvents()
    expect(registry.get(coachStateAtom).harnesses).toEqual([])

    listeners.onCoachHarnessesChanged!([row])
    await flushEvents()
    expect(registry.get(coachStateAtom).harnesses).toEqual([row])

    teardown()
    await flushEvents()
  })

  it('opens the section the orb asked for through navigation, dropping unknown ones', async () => {
    const navigate = vi.fn()
    setRouter(navigate)
    const listeners = captureApi()
    const teardown = subscribeToIpc(registry)
    await flushEvents()

    listeners.onNavigate!('optimize')
    await flushEvents()
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/optimize')

    listeners.onNavigate!('/etc/passwd')
    await flushEvents()
    expect(navigate).toHaveBeenCalledTimes(1)
    teardown()
    await flushEvents()
    setRouter(() => {})
  })
})

async function flushEvents(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}
