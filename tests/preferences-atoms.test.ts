import { AtomRegistry } from 'effect/reactivity'
import { describe, expect, it } from 'vitest'

import {
  hydratePreferences,
  preferencesAtom,
  updatePreferences,
} from '../src/renderer/features/settings/preferences-atoms.js'
import {
  defaultPreferences,
  type Preferences,
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

  emit(value: string | null): void {
    this.listener?.(value)
  }
}

const profile = (state: Partial<Preferences>) => JSON.stringify({ state, version: 0 })

describe('browser preferences', () => {
  it('hydrates a complete profile written by Zustand persist', () => {
    const storage = new MemoryStorage()
    const value = { ...defaultPreferences, theme: 'dark' as const, onboarded: true }
    storage.value = profile(value)
    const registry = AtomRegistry.make()

    const unsubscribe = hydratePreferences(registry, storage)
    expect(registry.get(preferencesAtom)).toEqual(value)
    unsubscribe()
  })

  it('fills missing fields from current defaults in an older profile', () => {
    const storage = new MemoryStorage()
    storage.value = profile({ theme: 'light', onboarded: true })
    const registry = AtomRegistry.make()

    hydratePreferences(registry, storage)
    expect(registry.get(preferencesAtom)).toEqual({ ...defaultPreferences, theme: 'light', onboarded: true })
  })

  it('accepts every persisted OverviewPeriod, including month', () => {
    const storage = new MemoryStorage()
    storage.value = profile({ defaultPeriod: 'month' })
    const registry = AtomRegistry.make()

    hydratePreferences(registry, storage)
    expect(registry.get(preferencesAtom).defaultPeriod).toBe('month')
  })

  it('uses defaults for missing, corrupt, or invalid storage values', () => {
    const registry = AtomRegistry.make()
    const storage = new MemoryStorage()
    hydratePreferences(registry, storage)
    expect(registry.get(preferencesAtom)).toEqual(defaultPreferences)

    storage.value = '{'
    hydratePreferences(registry, storage)
    expect(registry.get(preferencesAtom)).toEqual(defaultPreferences)

    storage.value = profile({ theme: 'neon' as Preferences['theme'] })
    hydratePreferences(registry, storage)
    expect(registry.get(preferencesAtom)).toEqual(defaultPreferences)
  })

  it('treats unavailable storage as an in-memory default', () => {
    const unavailable: PreferenceStorage = {
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
    const registry = AtomRegistry.make()

    expect(() => hydratePreferences(registry, unavailable)).not.toThrow()
    updatePreferences(registry, unavailable, { theme: 'dark' })
    expect(registry.get(preferencesAtom).theme).toBe('dark')
  })

  it('persists exactly the six fields in the existing version zero envelope', () => {
    const registry = AtomRegistry.make()
    const storage = new MemoryStorage()
    updatePreferences(registry, storage, { theme: 'dark', onboarded: true })

    expect(storage.writes).toEqual([
      {
        key: PREFERENCES_STORAGE_KEY,
        value: JSON.stringify({
          state: { ...defaultPreferences, theme: 'dark', onboarded: true },
          version: 0,
        }),
      },
    ])
  })

  it('applies external changes without writing them back to storage', () => {
    const storage = new MemoryStorage()
    const registry = AtomRegistry.make()
    const unsubscribe = hydratePreferences(registry, storage)
    storage.writes.length = 0

    storage.emit(profile({ theme: 'dark', defaultPeriod: 'week' }))
    expect(registry.get(preferencesAtom)).toEqual({ ...defaultPreferences, theme: 'dark', defaultPeriod: 'week' })
    expect(storage.writes).toEqual([])
    unsubscribe()
  })

  it('keeps values isolated between registries', () => {
    const first = AtomRegistry.make()
    const second = AtomRegistry.make()
    const firstStorage = new MemoryStorage()
    const secondStorage = new MemoryStorage()
    firstStorage.value = profile({ theme: 'dark' })
    secondStorage.value = profile({ theme: 'light' })

    hydratePreferences(first, firstStorage)
    hydratePreferences(second, secondStorage)
    expect(first.get(preferencesAtom).theme).toBe('dark')
    expect(second.get(preferencesAtom).theme).toBe('light')

    updatePreferences(first, firstStorage, { theme: 'system' })
    expect(first.get(preferencesAtom).theme).toBe('system')
    expect(second.get(preferencesAtom).theme).toBe('light')
  })

  it('ignores malformed external updates and can follow storage clearing', () => {
    const storage = new MemoryStorage()
    const registry = AtomRegistry.make()
    const unsubscribe = hydratePreferences(registry, storage)
    updatePreferences(registry, storage, { theme: 'dark' })

    storage.emit('{broken')
    expect(registry.get(preferencesAtom).theme).toBe('dark')
    storage.emit(null)
    expect(registry.get(preferencesAtom)).toEqual(defaultPreferences)
    unsubscribe()
  })
})
