import { describe, expect, it } from 'vitest'

import { periodAtom } from '../src/renderer/src/app/atoms/scope.js'
import { initializeRendererWindow } from '../src/renderer/src/app/renderer-root.js'
import { createRendererRuntimeOwner } from '../src/renderer/src/app/renderer-runtime.js'
import { preferencesAtom } from '../src/renderer/src/features/settings/preferences-atoms.js'

class BrowserFacade {
  readonly darkClasses: boolean[] = []
  readonly values = new Map<string, string>()
  readonly listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
  readonly localStorage: Storage = {
    get length() {
      return 0
    },
    clear: () => this.values.clear(),
    getItem: key => this.values.get(key) ?? null,
    key: index => Array.from(this.values.keys())[index] ?? null,
    removeItem: key => {
      this.values.delete(key)
    },
    setItem: (key, value) => this.values.set(key, value),
  }

  readonly window = {
    document: {
      documentElement: { classList: { toggle: (_name: string, dark: boolean) => this.darkClasses.push(dark) } },
    },
    matchMedia: () => ({ matches: true }),
    localStorage: this.localStorage,
    addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      const group = this.listeners.get(type) ?? new Set()
      group.add(listener)
      this.listeners.set(type, group)
    },
    removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => {
      this.listeners.get(type)?.delete(listener)
    },
  } as unknown as Window

  emitStorage(key: string | null, newValue: string | null): void {
    const event = { key, newValue } as StorageEvent
    for (const listener of this.listeners.get('storage') ?? []) {
      if (typeof listener === 'function') listener(event)
      else listener.handleEvent(event)
    }
  }
}

describe('renderer root hydration', () => {
  it('hydrates old preferences and seeds Scope before rendering', () => {
    const browser = new BrowserFacade()
    browser.values.set('watchtower:settings', JSON.stringify({ state: { defaultPeriod: 'month' }, version: 0 }))
    const owner = createRendererRuntimeOwner()

    initializeRendererWindow(browser.window, owner)

    expect(owner.registry.get(preferencesAtom).defaultPeriod).toBe('month')
    expect(owner.registry.get(periodAtom)).toBe('month')
    expect(browser.darkClasses).toEqual([true])
  })

  it('does not reset active Scope when another window changes the default period', () => {
    const browser = new BrowserFacade()
    browser.values.set('watchtower:settings', JSON.stringify({ state: { defaultPeriod: 'month' }, version: 0 }))
    const owner = createRendererRuntimeOwner()

    initializeRendererWindow(browser.window, owner)
    owner.registry.set(periodAtom, 'week')
    browser.emitStorage('watchtower:settings', JSON.stringify({ state: { defaultPeriod: 'lifetime' }, version: 0 }))

    expect(owner.registry.get(preferencesAtom).defaultPeriod).toBe('lifetime')
    expect(owner.registry.get(periodAtom)).toBe('week')
  })

  it('removes storage and unload listeners and disposes the registry', () => {
    const browser = new BrowserFacade()
    const owner = createRendererRuntimeOwner()
    const dispose = initializeRendererWindow(browser.window, owner)

    expect(browser.listeners.get('storage')?.size).toBe(1)
    expect(browser.listeners.get('beforeunload')?.size).toBe(1)
    dispose()

    expect(browser.listeners.get('storage')?.size).toBe(0)
    expect(browser.listeners.get('beforeunload')?.size).toBe(0)
    expect(owner.registry.getNodes().size).toBe(0)
  })
})
