import * as AtomRegistry from 'effect/reactivity/AtomRegistry'
import { describe, expect, it } from 'vitest'

import {
  APP_VERTICAL_STORAGE_KEY,
  appVerticalAtom,
  hydrateAppVertical,
  lastAnalyticsDestinationAtom,
  readStoredAppVertical,
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

  it('hydrates and persists the selected vertical through registry-owned storage', () => {
    const values = new Map<string, string>([[APP_VERTICAL_STORAGE_KEY, 'analytics']])
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    }
    const registry = AtomRegistry.make()
    hydrateAppVertical(registry, storage)
    expect(registry.get(appVerticalAtom)).toBe('analytics')

    registry.set(syncAppVerticalFromRouteAtom, { pathname: '/workspace' })
    expect(values.get(APP_VERTICAL_STORAGE_KEY)).toBe('workspace')
    registry.dispose()
  })

  it('defaults malformed or unavailable storage to Workspace', () => {
    expect(readStoredAppVertical({ getItem: () => 'unknown' })).toBe('workspace')
    expect(readStoredAppVertical(null)).toBe('workspace')
  })

  it('hydrates once per registry and keeps vertical state isolated', () => {
    const firstValues = new Map([[APP_VERTICAL_STORAGE_KEY, 'analytics']])
    const firstStorage = {
      getItem: (key: string) => firstValues.get(key) ?? null,
      setItem: (key: string, value: string) => firstValues.set(key, value),
    }
    const secondStorage = {
      getItem: () => 'workspace',
      setItem: () => {},
    }
    const first = AtomRegistry.make()
    const second = AtomRegistry.make()

    hydrateAppVertical(first, firstStorage)
    hydrateAppVertical(first, secondStorage)
    hydrateAppVertical(second, secondStorage)
    first.set(syncAppVerticalFromRouteAtom, { pathname: '/workspace' })

    expect(first.get(appVerticalAtom)).toBe('workspace')
    expect(second.get(appVerticalAtom)).toBe('workspace')
    expect(firstValues.get(APP_VERTICAL_STORAGE_KEY)).toBe('workspace')
    first.dispose()
    second.dispose()
  })

  it('keeps route synchronization working if storage writes fail', () => {
    const registry = AtomRegistry.make()
    hydrateAppVertical(registry, {
      getItem: () => null,
      setItem: () => {
        throw new Error('storage disabled')
      },
    })

    expect(() => registry.set(syncAppVerticalFromRouteAtom, { pathname: '/' })).not.toThrow()
    expect(registry.get(appVerticalAtom)).toBe('analytics')
    registry.dispose()
  })
})
