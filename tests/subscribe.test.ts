import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { appLifecycleReadinessAtom } from '../src/renderer/src/app/atoms/rpc-lifecycle.js'
import { initialScanState, scanStateAtom } from '../src/renderer/src/app/atoms/scan.js'
import { setRouter } from '../src/renderer/src/app/navigation.js'
import { navigationReadinessAtom, subscribeToNavigation } from '../src/renderer/src/app/stores/subscribe.js'

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

describe('native shell navigation subscription', () => {
  it('shares one navigation listener, applies valid Sections and releases the last holder', async () => {
    const navigate = vi.fn()
    const unsubscribe = vi.fn()
    let receive!: (payload: unknown) => void
    const onNavigate = vi.fn((listener: (payload: unknown) => void) => {
      receive = listener
      return unsubscribe
    })
    vi.stubGlobal('window', { api: { onNavigate } })
    setRouter(navigate)
    const first = subscribeToNavigation(registry)
    const second = subscribeToNavigation(registry)
    await vi.waitFor(() => expect(registry.get(navigationReadinessAtom)).toBe('ready'))
    expect(onNavigate).toHaveBeenCalledOnce()
    expect(registry.get(appLifecycleReadinessAtom).state).toBe('inactive')
    receive('optimize')
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith('/optimize'))
    receive('/etc/passwd')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(navigate).toHaveBeenCalledOnce()
    first()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(unsubscribe).not.toHaveBeenCalled()
    second()
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce())
  })

  it('keeps scan readiness and state independent of shell navigation failure', async () => {
    vi.stubGlobal('window', {
      api: {
        onNavigate: () => {
          throw new Error('unavailable')
        },
      },
    })
    const release = subscribeToNavigation(registry)
    await vi.waitFor(() => expect(registry.get(navigationReadinessAtom)).toBe('failed'))
    expect(registry.get(scanStateAtom)).toEqual(initialScanState())
    expect(registry.get(appLifecycleReadinessAtom).state).toBe('inactive')
    release()
  })
})
