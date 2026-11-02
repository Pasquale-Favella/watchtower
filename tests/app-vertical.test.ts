import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { describe, expect, it } from 'vitest'

import {
  appVerticalAtom,
  lastAnalyticsDestinationAtom,
  syncAppVerticalFromRouteAtom,
} from '../src/renderer/stores/atoms/app-vertical.js'

describe('app vertical atoms', () => {
  it('starts in Workspace and remembers the Analytics return route independently', () => {
    const registry = AtomRegistry.make()
    expect(registry.get(appVerticalAtom)).toBe('workspace')
    expect(registry.get(lastAnalyticsDestinationAtom)).toEqual({ to: '/' })

    registry.set(syncAppVerticalFromRouteAtom, { pathname: '/sessions/session-1', sourceId: 2 })
    registry.set(syncAppVerticalFromRouteAtom, { pathname: '/workspace' })
    expect(registry.get(appVerticalAtom)).toBe('workspace')
    expect(registry.get(lastAnalyticsDestinationAtom)).toEqual({ to: '/sessions/session-1', sourceId: 2 })
    registry.dispose()
  })
})
