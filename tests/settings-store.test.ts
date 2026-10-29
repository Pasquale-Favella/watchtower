import { AtomRegistry } from 'effect/reactivity'
import { describe, expect, it } from 'vitest'

import {
  hydratePreferences,
  preferencesAtom,
  setPreferencesAtom,
  updatePreferences,
} from '../src/renderer/features/settings/preferences-atoms.js'
import {
  defaultPreferences,
  PREFERENCES_STORAGE_KEY,
  type PreferenceStorage,
} from '../src/renderer/shared/lib/preferences.js'

class MemoryStorage implements PreferenceStorage {
  value: string | null = null
  writes: Array<{ key: string; value: string }> = []
  listener: ((value: string | null) => void) | undefined

  getItem(): string | null {
    return this.value
  }

  setItem(key: string, value: string): void {
    this.value = value
    this.writes.push({ key, value })
  }

  subscribe(listener: (value: string | null) => void): () => void {
    this.listener = listener
    return () => {
      this.listener = undefined
    }
  }
}

describe('native settings preferences', () => {
  it('hydrates and updates the registered preferences synchronously', () => {
    const registry = AtomRegistry.make()
    const storage = new MemoryStorage()
    const unsubscribe = hydratePreferences(registry, storage)

    registry.set(setPreferencesAtom, { theme: 'dark', onboarded: true, defaultPeriod: 'month' })

    expect(registry.get(preferencesAtom)).toEqual({
      ...defaultPreferences,
      theme: 'dark',
      onboarded: true,
      defaultPeriod: 'month',
    })
    expect(storage.writes).toEqual([
      {
        key: PREFERENCES_STORAGE_KEY,
        value: JSON.stringify({
          state: { ...defaultPreferences, theme: 'dark', onboarded: true, defaultPeriod: 'month' },
          version: 0,
        }),
      },
    ])
    unsubscribe()
  })

  it('keeps changes in memory when browser storage is unavailable', () => {
    const registry = AtomRegistry.make()
    const storage: PreferenceStorage = {
      getItem: () => {
        throw new Error('storage disabled')
      },
      setItem: () => {
        throw new Error('storage disabled')
      },
      subscribe: () => {
        throw new Error('storage disabled')
      },
    }

    const unsubscribe = hydratePreferences(registry, storage)
    expect(() => registry.set(setPreferencesAtom, { theme: 'light' })).not.toThrow()
    expect(registry.get(preferencesAtom).theme).toBe('light')
    unsubscribe()
  })

  it('keeps the hydrated storage binding after the compatibility update helper', () => {
    const registry = AtomRegistry.make()
    const storage = new MemoryStorage()
    const unsubscribe = hydratePreferences(registry, storage)

    updatePreferences(registry, storage, { theme: 'dark' })
    registry.set(setPreferencesAtom, { onboarded: true })

    expect(storage.writes).toHaveLength(2)
    expect(registry.get(preferencesAtom)).toEqual({ ...defaultPreferences, theme: 'dark', onboarded: true })
    unsubscribe()
  })

  it('does not write external preference updates back to their source', () => {
    const registry = AtomRegistry.make()
    const storage = new MemoryStorage()
    const unsubscribe = hydratePreferences(registry, storage)
    storage.writes.length = 0

    storage.listener?.(JSON.stringify({ state: { theme: 'light' }, version: 0 }))

    expect(registry.get(preferencesAtom).theme).toBe('light')
    expect(storage.writes).toEqual([])
    unsubscribe()
  })
})
