import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useScanStore } from '../src/renderer/src/app/stores/scan-store.js'
import { ORB_SCOPES, useOrbPanelStore } from '../src/renderer/src/orb/panel-store.js'
import { useOrbPlacementStore } from '../src/renderer/src/orb/placement-store.js'
import type { OrbPlacement } from '../src/shared/schemas/orb.js'

/** Stub the preload surface for the fetch wrappers' IPC-call sites. */
function mockWindow(api: unknown): void {
  ;(globalThis as { window?: unknown }).window = { api }
}

const expanded = { expanded: true, peek: false, horizontal: 'right', vertical: 'bottom' } satisfies OrbPlacement
const collapsed = { ...expanded, expanded: false } satisfies OrbPlacement

function orbApi(overrides: Record<string, unknown> = {}) {
  const requestPanel = vi.fn(async (intent: string) => (intent === 'fold' ? collapsed : expanded))
  return {
    getOverview: vi.fn(async () => null),
    getScanStatus: vi.fn(async () => ({ scanned: false })),
    getAnalytics: vi.fn(async () => null),
    orb: { requestPanel },
    ...overrides,
  }
}

beforeEach(() => {
  useOrbPanelStore.setState(useOrbPanelStore.getInitialState(), true)
  useOrbPlacementStore.setState(useOrbPlacementStore.getInitialState(), true)
  useScanStore.setState(useScanStore.getInitialState(), true)
})

describe('useOrbPlacementStore', () => {
  it('sends one intent and mirrors the placement the main process applied', async () => {
    const api = orbApi()
    mockWindow(api)
    await useOrbPlacementStore.getState().request('open')
    expect(api.orb.requestPanel).toHaveBeenCalledWith('open')
    expect(useOrbPlacementStore.getState().placement).toEqual(expanded)
    await useOrbPlacementStore.getState().request('fold')
    expect(useOrbPlacementStore.getState().placement).toEqual(collapsed)
  })

  it('drops a malformed placement instead of painting it', async () => {
    mockWindow(orbApi({ orb: { requestPanel: vi.fn(async () => ({ expanded: 'yes' })) } }))
    await useOrbPlacementStore.getState().request('open')
    expect(useOrbPlacementStore.getState().placement.expanded).toBe(false)
  })

  it('mirrors a broadcast placement, the main-owned peek flag included', () => {
    const peeking = { ...expanded, peek: true } satisfies OrbPlacement
    useOrbPlacementStore.getState().onPlacement(peeking)
    expect(useOrbPlacementStore.getState().placement).toEqual(peeking)
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
    await useOrbPlacementStore.getState().request('open')
    await useOrbPlacementStore.getState().request('fold')
    expect(api.getOverview).not.toHaveBeenCalled()
  })

  it('shares one load between concurrent callers', async () => {
    const api = orbApi()
    mockWindow(api)
    await Promise.all([useOrbPanelStore.getState().load(), useOrbPanelStore.getState().whenLoaded()])
    expect(api.getOverview).toHaveBeenCalledTimes(2)
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
