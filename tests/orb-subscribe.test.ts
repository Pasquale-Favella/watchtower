import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { OrbPlacement } from '../src/shared/schemas/orb.js'

const { subscribeToOrbBeacon } = await import('../src/renderer/src/orb/beacon-wiring.js')
const { subscribeToOrbPanel } = await import('../src/renderer/src/orb/panel-wiring.js')
const { useOrbPlacementStore } = await import('../src/renderer/src/orb/placement-store.js')
const { useScanStore } = await import('../src/renderer/src/app/stores/scan-store.js')
const { initializeRendererWindow } = await import('../src/renderer/src/app/renderer-root.js')
const { createRendererRuntimeOwner } = await import('../src/renderer/src/app/renderer-runtime.js')
const { preferencesAtom } = await import('../src/renderer/src/features/settings/preferences-atoms.js')

const placement = { expanded: false, peek: false, horizontal: 'left', vertical: 'top' } satisfies OrbPlacement
const storeChanged = {
  scanId: 'scan-1',
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: '2026-01-01T00:00:01Z',
  portedFiles: 1,
  unchangedFiles: 0,
  failedFiles: 0,
  perProvider: [],
  aborted: false,
}

/** A window whose every `on*` channel is captured for manual firing. */
function orbWindow() {
  const listeners: Record<string, (payload?: unknown) => void> = {}
  const events = new Map<string, (event: unknown) => void>()
  const storage = new Map<string, string>()
  const unsub = vi.fn()
  const capture =
    (name: string) =>
    (cb: (payload?: unknown) => void): (() => void) => {
      listeners[name] = cb
      return unsub
    }
  const api = {
    onProgress: capture('onProgress'),
    onError: capture('onError'),
    onChanged: capture('onChanged'),
    onIdle: capture('onIdle'),
    onConfigChanged: capture('onConfigChanged'),
    onCurrencyChanged: capture('onCurrencyChanged'),
    getScanStatus: vi.fn(async () => ({ scanned: true })),
    getAnalytics: vi.fn(async () => null),
    getOverview: vi.fn(async () => null),
    orb: {
      onPlacement: capture('onPlacement'),
      requestPanel: vi.fn(async () => ({ ...placement, expanded: true })),
    },
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
  return { api, listeners, events, unsub }
}

beforeEach(() => {
  useOrbPlacementStore.setState(useOrbPlacementStore.getInitialState(), true)
  useScanStore.setState(useScanStore.getInitialState(), true)
})

describe('subscribeToOrbBeacon — the light orb (ADR 0011)', () => {
  it('follows any window’s scan, and a finished one only ends the spinner (no fetch)', () => {
    const { api, listeners } = orbWindow()
    const teardown = subscribeToOrbBeacon()
    listeners.onProgress?.({ stage: 'parse', provider: 'openai', processed: 1, total: 4 })
    expect(useScanStore.getState().scanning).toBe(true)
    listeners.onChanged?.(storeChanged)
    expect(useScanStore.getState().scanning).toBe(false)
    expect(api.getScanStatus).not.toHaveBeenCalled()
    expect(api.getOverview).not.toHaveBeenCalled()
    teardown()
  })

  it('mirrors placements, dropping malformed ones', () => {
    const { listeners } = orbWindow()
    const teardown = subscribeToOrbBeacon()
    listeners.onPlacement?.(placement)
    expect(useOrbPlacementStore.getState().placement).toEqual(placement)
    listeners.onPlacement?.({ expanded: 'yes' })
    expect(useOrbPlacementStore.getState().placement).toEqual(placement)
    teardown()
  })

  it('subscribes to no data-plane refetch channels', () => {
    const { listeners } = orbWindow()
    subscribeToOrbBeacon()()
    expect(listeners.onConfigChanged).toBeUndefined()
    expect(listeners.onCurrencyChanged).toBeUndefined()
  })
})

describe('subscribeToOrbPanel (ADR 0011)', () => {
  it('a finished scan refetches through the shared change path', async () => {
    const { api, listeners } = orbWindow()
    const teardown = subscribeToOrbPanel()
    listeners.onChanged?.(storeChanged)
    await vi.waitFor(() => expect(api.getScanStatus).toHaveBeenCalled())
    teardown()
  })

  it('mirrors the placement — the peek flag included — into the placement store', () => {
    const { listeners } = orbWindow()
    const teardown = subscribeToOrbPanel()
    const peeking = { ...placement, expanded: true, peek: true } satisfies OrbPlacement
    listeners.onPlacement?.(peeking)
    expect(useOrbPlacementStore.getState().placement).toEqual(peeking)
    listeners.onPlacement?.(placement)
    expect(useOrbPlacementStore.getState().placement).toEqual(placement)
    teardown()
  })

  it('uses the root-owned preference storage listener without adding a duplicate', () => {
    const browser = orbWindow()
    const owner = createRendererRuntimeOwner()
    const disposeRoot = initializeRendererWindow(window, owner)
    const storageListener = browser.events.get('storage')
    expect(storageListener).toBeDefined()
    const teardown = subscribeToOrbPanel()
    expect(browser.events.get('storage')).toBe(storageListener)
    storageListener?.({
      key: 'watchtower:settings',
      newValue: JSON.stringify({ state: { theme: 'dark' }, version: 0 }),
    })
    expect(owner.registry.get(preferencesAtom).theme).toBe('dark')
    teardown()
    expect(browser.events.get('storage')).toBe(storageListener)
    disposeRoot()
    expect(browser.events.has('storage')).toBe(false)
  })

  it('teardown unsubscribes every channel', () => {
    const { unsub } = orbWindow()
    subscribeToOrbPanel()()
    // Data plane: 4 scan lifecycle + config + currency; then placement.
    expect(unsub).toHaveBeenCalledTimes(7)
  })
})
