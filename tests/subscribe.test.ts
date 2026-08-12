import { beforeEach, describe, expect, it, vi } from 'vitest'

import { subscribeToIpc } from '../src/renderer/src/app/stores/subscribe.js'
import { useScanStore } from '../src/renderer/src/app/stores/scan-store.js'
import { useSettingsStore } from '../src/renderer/src/features/settings/store.js'

/** Stub the preload surface: capture each on* callback for manual firing,
 * merging any extra (fetch) methods onto the same `window.api`. */
function captureApi(extra?: Record<string, unknown>): Record<string, (payload?: unknown) => void> {
  const listeners: Record<string, (payload?: unknown) => void> = {}
  mockWindow({
    onProgress: (cb: (p: unknown) => void) => { listeners.onProgress = cb; return () => {} },
    onError: (cb: (p: string) => void) => { listeners.onError = cb; return () => {} },
    onChanged: (cb: (p: unknown) => void) => { listeners.onChanged = cb; return () => {} },
    onIdle: (cb: () => void) => { listeners.onIdle = cb; return () => {} },
    onCurrencyChanged: (cb: (p: unknown) => void) => { listeners.onCurrencyChanged = cb; return () => {} },
    onConfigChanged: (cb: () => void) => { listeners.onConfigChanged = cb; return () => {} },
    onCoachEvent: (cb: (p: unknown) => void) => { listeners.onCoachEvent = cb; return () => {} },
    ...extra,
  })
  return listeners
}

function mockWindow(api: unknown): void {
  ;(globalThis as { window?: unknown }).window = { api }
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

beforeEach(() => {
  useScanStore.setState(useScanStore.getInitialState(), true)
  useSettingsStore.setState(useSettingsStore.getInitialState(), true)
})

describe('subscribeToIpc (ADR 0011)', () => {
  it('feeds scan progress into the scan store, dropping malformed broadcasts', () => {
    const listeners = captureApi()
    const teardown = subscribeToIpc()

    listeners.onProgress!({ stage: 'parse', provider: 'openai', processed: 5, total: 9 })
    expect(useScanStore.getState().scanning).toBe(true)
    expect(useScanStore.getState().progress).toEqual([{ provider: 'openai', processed: 5, total: 9, done: false }])

    listeners.onProgress!({ stage: 'port-in', provider: 'openai', processed: 9, total: 9 })
    expect(useScanStore.getState().progress[0]!.done).toBe(true)

    listeners.onProgress!({ stage: 'nope' })
    expect(useScanStore.getState().progress).toHaveLength(1)

    teardown()
  })

  it('feeds scan errors and idle events into the scan store', () => {
    const listeners = captureApi()
    const teardown = subscribeToIpc()

    listeners.onError!('boom')
    expect(useScanStore.getState().scanError).toBe('boom')
    expect(useScanStore.getState().scanning).toBe(false)

    useScanStore.getState().onProgress('openai', 1, 1, false)
    listeners.onIdle!()
    expect(useScanStore.getState().scanning).toBe(false)
    expect(useScanStore.getState().progress).toEqual([])

    teardown()
  })

  it('applies a store:changed broadcast through applyChange', async () => {
    const listeners = captureApi({
      getScanStatus: () => Promise.resolve(statusScanned),
      getAnalytics: () => Promise.resolve(analytics),
    })
    const teardown = subscribeToIpc()

    listeners.onChanged!(storeChanged)
    await vi.waitFor(() => expect(useScanStore.getState().hydrated).toBe(true))
    expect(useScanStore.getState().unparsedTotal).toBe(3)
    expect(useScanStore.getState().refreshVersion).toBe(1)

    teardown()
  })

  it('drops a malformed store:changed broadcast', async () => {
    const listeners = captureApi()
    const teardown = subscribeToIpc()
    listeners.onChanged!({ bogus: 1 })
    expect(useScanStore.getState().refreshVersion).toBe(0)
    teardown()
  })

  it('applies a config:changed broadcast through applyChange', async () => {
    const listeners = captureApi({
      getScanStatus: () => Promise.resolve(statusScanned),
      getAnalytics: () => Promise.resolve(analytics),
    })
    const teardown = subscribeToIpc()

    listeners.onConfigChanged!()
    await vi.waitFor(() => expect(useScanStore.getState().refreshVersion).toBe(1))

    teardown()
  })

  it('feeds a currency:changed broadcast into the settings store, dropping malformed ones', () => {
    const listeners = captureApi()
    const teardown = subscribeToIpc()

    listeners.onCurrencyChanged!({ code: 'EUR', symbol: '€', rate: 0.9 })
    expect(useSettingsStore.getState().activeCurrency).toEqual({ code: 'EUR', symbol: '€', rate: 0.9 })

    listeners.onCurrencyChanged!({ code: 123 })
    expect(useSettingsStore.getState().activeCurrency.code).toBe('EUR')

    teardown()
  })

  it('teardown unsubscribes every listener', () => {
    const unsub = vi.fn(() => {})
    const listeners: Record<string, (payload?: unknown) => void> = {}
    mockWindow({
      onProgress: (cb: (p: unknown) => void) => { listeners.onProgress = cb; return unsub },
      onError: (cb: (p: string) => void) => { listeners.onError = cb; return unsub },
      onChanged: (cb: (p: unknown) => void) => { listeners.onChanged = cb; return unsub },
      onIdle: (cb: () => void) => { listeners.onIdle = cb; return unsub },
      onCurrencyChanged: (cb: (p: unknown) => void) => { listeners.onCurrencyChanged = cb; return unsub },
      onConfigChanged: (cb: () => void) => { listeners.onConfigChanged = cb; return unsub },
      onCoachEvent: (cb: (p: unknown) => void) => { listeners.onCoachEvent = cb; return unsub },
    })
    const teardown = subscribeToIpc()
    teardown()
    expect(unsub).toHaveBeenCalledTimes(7)
  })
})
