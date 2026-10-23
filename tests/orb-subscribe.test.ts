import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initialScanState } from '../src/renderer/src/app/atoms/scan.js'
import type { OrbPlacement } from '../src/shared/schemas/orb.js'

const { subscribeToOrbBeacon } = await import('../src/renderer/src/orb/beacon-wiring.js')
const { subscribeToOrbPanel } = await import('../src/renderer/src/orb/panel-wiring.js')
const { placementAtom } = await import('../src/renderer/src/orb/placement-atoms.js')
const { scanStateAtom } = await import('../src/renderer/src/app/atoms/scan.js')
let registry: AtomRegistry.AtomRegistry
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

afterEach(() => {
  registry.dispose()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  registry = AtomRegistry.make()
  registry.set(scanStateAtom, initialScanState())
})

describe('subscribeToOrbBeacon — the light orb (ADR 0011)', () => {
  it('follows any window’s scan, and a finished one only ends the spinner (no fetch)', async () => {
    const { api, listeners } = orbWindow()
    const teardown = subscribeToOrbBeacon(registry)
    await flushEvents()
    listeners.onProgress?.({ stage: 'parse', provider: 'openai', processed: 1, total: 4 })
    await flushEvents()
    expect(registry.get(scanStateAtom).scanning).toBe(true)
    listeners.onChanged?.(storeChanged)
    await flushEvents()
    expect(registry.get(scanStateAtom).scanning).toBe(false)
    expect(api.getScanStatus).not.toHaveBeenCalled()
    expect(api.getOverview).not.toHaveBeenCalled()
    teardown()
    await flushEvents()
  })

  it('mirrors placements, dropping malformed ones', async () => {
    const { listeners } = orbWindow()
    const teardown = subscribeToOrbBeacon(registry)
    await flushEvents()
    listeners.onPlacement?.(placement)
    await flushEvents()
    expect(registry.get(placementAtom)).toEqual(placement)
    listeners.onPlacement?.({ expanded: 'yes' })
    await flushEvents()
    expect(registry.get(placementAtom)).toEqual(placement)
    teardown()
    await flushEvents()
  })

  it('subscribes to no data-plane refetch channels', async () => {
    const { listeners } = orbWindow()
    subscribeToOrbBeacon(registry)()
    await flushEvents()
    expect(listeners.onConfigChanged).toBeUndefined()
    expect(listeners.onCurrencyChanged).toBeUndefined()
  })
})

describe('subscribeToOrbPanel (ADR 0011)', () => {
  it('a finished scan refetches through the shared change path', async () => {
    const { api, listeners } = orbWindow()
    const teardown = subscribeToOrbPanel(registry)
    await flushEvents()
    listeners.onChanged?.(storeChanged)
    await flushEvents()
    await vi.waitFor(() => expect(api.getScanStatus).toHaveBeenCalled())
    teardown()
    await flushEvents()
  })

  it('mirrors the placement — the peek flag included — into the placement store', async () => {
    const { listeners } = orbWindow()
    const teardown = subscribeToOrbPanel(registry)
    await flushEvents()
    const peeking = { ...placement, expanded: true, peek: true } satisfies OrbPlacement
    listeners.onPlacement?.(peeking)
    await flushEvents()
    expect(registry.get(placementAtom)).toEqual(peeking)
    listeners.onPlacement?.(placement)
    await flushEvents()
    expect(registry.get(placementAtom)).toEqual(placement)
    teardown()
    await flushEvents()
  })

  it('uses the root-owned preference storage listener without adding a duplicate', async () => {
    const browser = orbWindow()
    const owner = createRendererRuntimeOwner()
    const disposeRoot = initializeRendererWindow(window, owner)
    const storageListener = browser.events.get('storage')
    expect(storageListener).toBeDefined()
    const teardown = subscribeToOrbPanel(registry)
    await flushEvents()
    expect(browser.events.get('storage')).toBe(storageListener)
    storageListener?.({
      key: 'watchtower:settings',
      newValue: JSON.stringify({ state: { theme: 'dark' }, version: 0 }),
    })
    expect(owner.registry.get(preferencesAtom).theme).toBe('dark')
    teardown()
    await flushEvents()
    expect(browser.events.get('storage')).toBe(storageListener)
    disposeRoot()
    expect(browser.events.has('storage')).toBe(false)
  })

  it('teardown unsubscribes every channel', async () => {
    const { unsub } = orbWindow()
    subscribeToOrbPanel(registry)()
    await flushEvents()
    // Data plane: 4 scan lifecycle + config + currency; then placement.
    expect(unsub).toHaveBeenCalledTimes(7)
  })
})

async function flushEvents(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}
