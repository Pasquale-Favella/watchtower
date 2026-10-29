import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { describe, expect, it, vi } from 'vitest'
import { setRouter } from '../src/renderer/src/app/navigation.js'
import { navigationReadinessAtom, subscribeToNavigation } from '../src/renderer/src/app/stores/subscribe.js'
import { makeShellBridge } from './shell-bridge.js'

describe('serialized shell navigation', () => {
  it('preserves ordered Sections and fails visibly on an invalid wire payload', async () => {
    const registry = AtomRegistry.make()
    const remote = makeShellBridge()
    vi.stubGlobal('window', { api: { rpcV1: remote.bridge } })
    const navigate = vi.fn()
    setRouter(navigate)
    const release = subscribeToNavigation(registry)
    try {
      await vi.waitFor(() => expect(registry.get(navigationReadinessAtom)).toBe('ready'))
      remote.emit({ _tag: 'Navigate', section: 'models' })
      remote.emit({ _tag: 'Navigate', section: 'sessions' })
      await vi.waitFor(() => expect(navigate.mock.calls).toEqual([['/models'], ['/sessions']]))
      remote.emit({ _tag: 'Navigate', section: '/private/path' as never })
      await vi.waitFor(() => expect(registry.get(navigationReadinessAtom)).toBe('failed'))
      expect(navigate).toHaveBeenCalledTimes(2)
    } finally {
      release()
      registry.dispose()
      setRouter(() => {})
      vi.unstubAllGlobals()
    }
  })
})
