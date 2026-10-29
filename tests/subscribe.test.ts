import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initialScanState, scanStateAtom } from '../src/renderer/stores/atoms/scan.js'
import { appLifecycleReadinessAtom } from '../src/renderer/stores/atoms/rpc-lifecycle.js'
import { setRouter } from '../src/renderer/app/navigation.js'
import { navigationReadinessAtom, subscribeToNavigation } from '../src/renderer/stores/subscribe.js'
import { makeShellBridge } from './shell-bridge.js'

let registry: AtomRegistry.AtomRegistry
beforeEach(() => {
  registry = AtomRegistry.make()
  registry.set(scanStateAtom, initialScanState())
})
afterEach(() => {
  registry.dispose()
  setRouter(() => {})
  vi.unstubAllGlobals()
})

describe('RPC shell navigation subscription', () => {
  it('shares one stream until its last holder and applies typed Sections', async () => {
    const remote = makeShellBridge()
    vi.stubGlobal('window', { api: { rpcV1: remote.bridge } })
    const navigate = vi.fn()
    setRouter(navigate)
    const first = subscribeToNavigation(registry)
    const second = subscribeToNavigation(registry)
    await vi.waitFor(() => expect(registry.get(navigationReadinessAtom)).toBe('ready'))
    expect(remote.counts().requests).toBe(1)
    expect(registry.get(appLifecycleReadinessAtom).state).toBe('inactive')
    remote.emit({ _tag: 'Navigate', section: 'optimize' })
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith('/optimize'))
    first()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(remote.counts().interrupts).toBe(0)
    second()
    await vi.waitFor(() => expect(remote.counts().listeners).toBe(0))
  })
  it('keeps scan readiness independent of an unavailable shell connection', async () => {
    const remote = makeShellBridge(true)
    vi.stubGlobal('window', { api: { rpcV1: remote.bridge } })
    const release = subscribeToNavigation(registry)
    await vi.waitFor(() => expect(registry.get(navigationReadinessAtom)).toBe('failed'))
    expect(registry.get(scanStateAtom)).toEqual(initialScanState())
    expect(registry.get(appLifecycleReadinessAtom).state).toBe('inactive')
    release()
  })
})
