import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useScanStore } from '../src/renderer/src/app/stores/scan-store.js'
import { BACKGROUNDED_PEEK, ORB_SCOPES, useOrbPanelStore } from '../src/renderer/src/orb/panel-store.js'
import { useOrbPlacementStore } from '../src/renderer/src/orb/placement-store.js'

/** Stub the preload surface for the fetch wrappers' IPC-call sites. */
function mockWindow(api: unknown): void {
  ;(globalThis as { window?: unknown }).window = { api }
}

const expanded = { expanded: true, horizontal: 'right', vertical: 'bottom' }
const collapsed = { ...expanded, expanded: false }

function orbApi(overrides: Record<string, unknown> = {}) {
  const setExpanded = vi.fn(async (...args: [boolean, boolean?]) => (args[0] ? expanded : collapsed))
  return {
    getOverview: vi.fn(async () => null),
    getScanStatus: vi.fn(async () => ({ scanned: false })),
    getAnalytics: vi.fn(async () => null),
    orb: { setExpanded },
    ...overrides,
  }
}

beforeEach(() => {
  useOrbPanelStore.setState(useOrbPanelStore.getInitialState(), true)
  useOrbPlacementStore.setState(useOrbPlacementStore.getInitialState(), true)
  useScanStore.setState(useScanStore.getInitialState(), true)
})

describe('useOrbPlacementStore', () => {
  it('mirrors the placement the main process applies, passing focus through', async () => {
    const api = orbApi()
    mockWindow(api)
    await useOrbPlacementStore.getState().setExpanded(true, true)
    expect(api.orb.setExpanded).toHaveBeenCalledWith(true, true)
    expect(useOrbPlacementStore.getState().placement).toEqual(expanded)
  })

  it('drops a malformed placement instead of painting it', async () => {
    mockWindow(orbApi({ orb: { setExpanded: vi.fn(async () => ({ expanded: 'yes' })) } }))
    await useOrbPlacementStore.getState().setExpanded(true)
    expect(useOrbPlacementStore.getState().placement.expanded).toBe(false)
  })
})

describe('useOrbPanelStore', () => {
  it('loads the today and last-30-days Overview payloads', async () => {
    const api = orbApi()
    mockWindow(api)
    await useOrbPanelStore.getState().load()
    expect(api.getOverview).toHaveBeenCalledWith(ORB_SCOPES.today)
    expect(api.getOverview).toHaveBeenCalledWith(ORB_SCOPES.recent)
    expect(api.getOverview).toHaveBeenCalledTimes(2)
    const state = useOrbPanelStore.getState()
    expect([state.today.status, state.recent.status]).toEqual(['ready', 'ready'])
  })

  it('never refetches just because the panel opens (ADR 0004)', async () => {
    const api = orbApi()
    mockWindow(api)
    await useOrbPanelStore.getState().load()
    api.getOverview.mockClear()
    await useOrbPlacementStore.getState().setExpanded(true)
    await useOrbPlacementStore.getState().setExpanded(false)
    expect(api.getOverview).not.toHaveBeenCalled()
  })

  it('shares one load between concurrent callers', async () => {
    const api = orbApi()
    mockWindow(api)
    await Promise.all([useOrbPanelStore.getState().load(), useOrbPanelStore.getState().whenLoaded()])
    expect(api.getOverview).toHaveBeenCalledTimes(2)
  })

  it('peeks open inactive with a note once its data is loaded', async () => {
    const api = orbApi()
    mockWindow(api)
    useOrbPanelStore.getState().onNotice({ kind: 'backgrounded' })
    await vi.waitFor(() => expect(useOrbPanelStore.getState().peek).toBe(BACKGROUNDED_PEEK))
    expect(api.getOverview).toHaveBeenCalledTimes(2)
    expect(api.orb.setExpanded).toHaveBeenCalledWith(true, false)
    useOrbPanelStore.getState().clearPeek()
    expect(useOrbPanelStore.getState().peek).toBeNull()
  })

  it('a summon opens the panel focused, without a note', async () => {
    const api = orbApi()
    mockWindow(api)
    useOrbPanelStore.getState().onNotice({ kind: 'summoned' })
    await vi.waitFor(() => expect(useOrbPlacementStore.getState().placement.expanded).toBe(true))
    expect(api.orb.setExpanded).toHaveBeenCalledWith(true, true)
    expect(useOrbPanelStore.getState().peek).toBeNull()
  })

  it('reloads on the shared refresh tick only once it has loaded', async () => {
    const api = orbApi()
    mockWindow(api)
    await useScanStore.getState().applyChange()
    expect(api.getOverview).not.toHaveBeenCalled()

    await useOrbPanelStore.getState().load()
    api.getOverview.mockClear()
    await useScanStore.getState().applyChange()
    await vi.waitFor(() => expect(api.getOverview).toHaveBeenCalledTimes(2))
  })
})
