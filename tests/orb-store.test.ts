import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useScanStore } from '../src/renderer/src/app/stores/scan-store.js'
import { BACKGROUNDED_PEEK, ORB_SCOPES, useOrbStore } from '../src/renderer/src/orb/store.js'

/** Stub the preload surface for the fetch wrappers' IPC-call sites. */
function mockWindow(api: unknown): void {
  ;(globalThis as { window?: unknown }).window = { api }
}

const expanded = { expanded: true, horizontal: 'right', vertical: 'bottom' }
const collapsed = { ...expanded, expanded: false }

function orbApi(overrides: Record<string, unknown> = {}) {
  const setExpanded = vi.fn(async (next: boolean) => (next ? expanded : collapsed))
  return {
    getOverview: vi.fn(async () => null),
    getScanStatus: vi.fn(async () => ({ scanned: false })),
    getAnalytics: vi.fn(async () => null),
    orb: { setExpanded },
    ...overrides,
  }
}

beforeEach(() => {
  useOrbStore.setState(useOrbStore.getInitialState(), true)
  useScanStore.setState(useScanStore.getInitialState(), true)
})

describe('useOrbStore', () => {
  it('loads the today and last-30-days Overview payloads', async () => {
    const api = orbApi()
    mockWindow(api)
    await useOrbStore.getState().load()
    expect(api.getOverview).toHaveBeenCalledWith(ORB_SCOPES.today)
    expect(api.getOverview).toHaveBeenCalledWith(ORB_SCOPES.recent)
    expect(api.getOverview).toHaveBeenCalledTimes(2)
    const state = useOrbStore.getState()
    expect([state.today.status, state.recent.status]).toEqual(['ready', 'ready'])
    expect(state.loadedAt).toBeGreaterThan(0)
  })

  it('mirrors the placement the main process applies', async () => {
    const api = orbApi()
    mockWindow(api)
    await useOrbStore.getState().setExpanded(true)
    expect(api.orb.setExpanded).toHaveBeenCalledWith(true)
    expect(useOrbStore.getState().placement).toEqual(expanded)
  })

  it('drops a malformed placement instead of painting it', async () => {
    mockWindow(orbApi({ orb: { setExpanded: vi.fn(async () => ({ expanded: 'yes' })) } }))
    await useOrbStore.getState().setExpanded(true)
    expect(useOrbStore.getState().placement.expanded).toBe(false)
  })

  it('peeks open with a note after the window is backgrounded; folding clears it', async () => {
    mockWindow(orbApi())
    useOrbStore.getState().onNotice({ kind: 'backgrounded' })
    await vi.waitFor(() => expect(useOrbStore.getState().peek).toBe(BACKGROUNDED_PEEK))
    expect(useOrbStore.getState().placement.expanded).toBe(true)

    useOrbStore.getState().onPlacement(collapsed as never)
    expect(useOrbStore.getState().peek).toBeNull()
  })

  it('a summon unfolds straight to the panel, without a note', async () => {
    mockWindow(orbApi())
    useOrbStore.getState().onNotice({ kind: 'summoned' })
    await vi.waitFor(() => expect(useOrbStore.getState().placement.expanded).toBe(true))
    expect(useOrbStore.getState().peek).toBeNull()
  })

  it('reloads on the shared refresh tick only once it has loaded', async () => {
    const api = orbApi({ getScanStatus: vi.fn(async () => ({ scanned: false })) })
    mockWindow(api)
    await useScanStore.getState().applyChange()
    expect(api.getOverview).not.toHaveBeenCalled()

    await useOrbStore.getState().load()
    api.getOverview.mockClear()
    await useScanStore.getState().applyChange()
    await vi.waitFor(() => expect(api.getOverview).toHaveBeenCalledTimes(2))
  })
})
