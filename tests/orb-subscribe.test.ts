import { beforeEach, describe, expect, it, vi } from 'vitest'

// The settings store's persist API exists only when `localStorage` does at
// module load (see settings-store.test.ts): install a memory storage BEFORE
// the dynamic imports, since the orb wiring rehydrates through it.
const memory = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => void memory.set(key, value),
  removeItem: (key: string) => void memory.delete(key),
})

const { subscribeToOrbIpc } = await import('../src/renderer/src/app/stores/subscribe.js')
const { useOrbStore } = await import('../src/renderer/src/orb/store.js')
const { useSettingsStore } = await import('../src/renderer/src/features/settings/store.js')

describe('subscribeToOrbIpc (ADR 0011)', () => {
  const placement = { expanded: false, horizontal: 'left', vertical: 'top' }

  function orbWindow(takePendingNotice: () => Promise<unknown> = vi.fn(async () => null)) {
    const listeners: Record<string, (payload?: unknown) => void> = {}
    const events = new Map<string, (event: unknown) => void>()
    const unsub = vi.fn()
    vi.stubGlobal('window', {
      api: {
        orb: {
          onPlacement: (cb: (p: unknown) => void) => {
            listeners.onPlacement = cb
            return unsub
          },
          onNotice: (cb: (p: unknown) => void) => {
            listeners.onNotice = cb
            return unsub
          },
          takePendingNotice,
          setExpanded: vi.fn(async () => ({ ...placement, expanded: true })),
        },
        getOverview: vi.fn(async () => null),
      },
      addEventListener: (type: string, cb: (event: unknown) => void) => events.set(type, cb),
      removeEventListener: (type: string) => events.delete(type),
    })
    return { listeners, events, unsub }
  }

  beforeEach(() => {
    useOrbStore.setState(useOrbStore.getInitialState(), true)
  })

  it('feeds placements into the orb store, dropping malformed ones', () => {
    const { listeners } = orbWindow()
    const teardown = subscribeToOrbIpc()
    listeners.onPlacement!(placement)
    expect(useOrbStore.getState().placement).toEqual(placement)
    listeners.onPlacement!({ expanded: 'yes' })
    expect(useOrbStore.getState().placement).toEqual(placement)
    teardown()
  })

  it('pulls a notice raised before the page could listen', async () => {
    orbWindow(vi.fn(async () => ({ kind: 'summoned' })))
    const teardown = subscribeToOrbIpc()
    await vi.waitFor(() => expect(useOrbStore.getState().placement.expanded).toBe(true))
    teardown()
  })

  it('rehydrates the persisted settings when the main window writes them', () => {
    const { events } = orbWindow()
    const rehydrate = vi.spyOn(useSettingsStore.persist, 'rehydrate').mockResolvedValue()
    const teardown = subscribeToOrbIpc()
    events.get('storage')!({ key: 'unrelated' })
    expect(rehydrate).not.toHaveBeenCalled()
    events.get('storage')!({ key: useSettingsStore.persist.getOptions().name })
    expect(rehydrate).toHaveBeenCalledTimes(1)
    teardown()
    expect(events.has('storage')).toBe(false)
    rehydrate.mockRestore()
  })

  it('teardown unsubscribes both orb channels', () => {
    const { unsub } = orbWindow()
    subscribeToOrbIpc()()
    expect(unsub).toHaveBeenCalledTimes(2)
  })
})
