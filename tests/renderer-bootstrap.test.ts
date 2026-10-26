import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { expect, it, vi } from 'vitest'

import { appLifecycleReadinessAtom } from '../src/renderer/src/app/atoms/rpc-lifecycle.js'
import { scanStateAtom } from '../src/renderer/src/app/atoms/scan.js'
import { appBootstrapAtom } from '../src/renderer/src/app/hooks/use-app-bootstrap.js'
import { updatesMachineAtom } from '../src/renderer/src/features/settings/updates-atoms.js'

it('subscribes before the first scan and hydrates when completion precedes the command acknowledgement', async () => {
  const registry = AtomRegistry.make()
  const listeners = new Map<string, (payload?: unknown) => void>()
  let scanned = false
  let attached = false
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
  const capture = (name: string) => (listener: (payload?: unknown) => void) => {
    listeners.set(name, listener)
    if (name === 'onNavigate') attached = true
    return () => {
      listeners.delete(name)
    }
  }
  const getCurrency = vi.fn(async () => ({ code: 'USD', symbol: '$', rate: 1 }))
  const scan = vi.fn(async () => {
    expect(attached).toBe(true)
    scanned = true
    listeners.get('onChanged')?.(metadata)
    return { ok: true }
  })
  const api = {
    ...Object.fromEntries(
      [
        'onProgress',
        'onError',
        'onChanged',
        'onIdle',
        'onConfigChanged',
        'onCurrencyChanged',
        'onUpdateChanged',
        'onCoachEvent',
        'onCoachHarnessesChanged',
        'onNavigate',
      ].map(name => [name, capture(name)]),
    ),
    platform: 'win32',
    getScanStatus: () =>
      new Promise(resolve => setTimeout(() => resolve({ scanned, ...(scanned ? { metadata } : {}) }), 20)),
    getScanActive: async () => false,
    getAnalytics: async () => null,
    getCadence: async () => '1m',
    getCurrency,
    getCurrencies: async () => [],
    getUpdateStatus: () =>
      new Promise(resolve =>
        setTimeout(
          () =>
            resolve({
              revision: 0,
              phase: 'idle',
              currentVersion: '0.2.11',
              latestVersion: null,
              updateAvailable: false,
              tag: null,
              installSupported: true,
              progress: null,
              message: null,
            }),
          20,
        ),
      ),
    scan,
  }
  vi.stubGlobal('window', { api })
  const unmount = registry.mount(appBootstrapAtom)
  try {
    await vi.waitFor(() => expect(registry.get(appLifecycleReadinessAtom).state).toBe('failed'))
    await vi.waitFor(() => expect(registry.get(scanStateAtom).hydrated).toBe(true))
    await vi.waitFor(() => expect(getCurrency).toHaveBeenCalledTimes(1))
    expect(scan).toHaveBeenCalledTimes(1)
    expect(registry.get(scanStateAtom).scanning).toBe(false)
    await vi.waitFor(() => expect(registry.get(updatesMachineAtom)).toMatchObject({ state: 'synced' }))
  } finally {
    unmount()
    registry.dispose()
    vi.unstubAllGlobals()
  }
})
