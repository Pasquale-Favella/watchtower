import { beforeEach, describe, expect, it, vi } from 'vitest'

import { usePricingStore } from '../src/renderer/src/features/models/pricing-store.js'
import { useScanStore } from '../src/renderer/src/app/stores/scan-store.js'

function mockWindow(api: unknown): void {
  ;(globalThis as { window?: unknown }).window = { api }
}

const statusScanned = {
  scanned: true,
  metadata: {
    scanId: 'scan-1',
    startedAt: '2026-01-01T00:00:00Z',
    completedAt: '2026-01-01T00:00:01Z',
    portedFiles: 1,
    unchangedFiles: 0,
    failedFiles: 0,
    perProvider: [{ provider: 'openai', ported: 1, unchanged: 0, failed: 0, unparsed: 0 }],
    aborted: false,
  },
}

const analytics = { providers: [], models: [], categories: [], skills: [], subagents: [] }

beforeEach(() => {
  useScanStore.setState(useScanStore.getInitialState(), true)
  usePricingStore.setState(usePricingStore.getInitialState(), true)
})

describe('usePricingStore (map ticket 02/05)', () => {
  it('starts with no aliases or overrides loaded', () => {
    const s = usePricingStore.getState()
    expect(s.aliases).toBeNull()
    expect(s.overrides).toBeNull()
    expect(s.error).toBeNull()
  })

  it('loads aliases and overrides from the main process', async () => {
    mockWindow({
      getModelAliases: () => Promise.resolve([{ model: 'foo', aliasOf: 'bar' }]),
      getPriceOverrides: () => Promise.resolve([{ model: 'baz', inputPricePerMillion: 1, outputPricePerMillion: 2 }]),
    })
    const { loadAliases, loadOverrides } = usePricingStore.getState()
    await loadAliases()
    await loadOverrides()
    const s = usePricingStore.getState()
    expect(s.aliases).toEqual([{ model: 'foo', aliasOf: 'bar' }])
    expect(s.overrides).toEqual([{ model: 'baz', inputPricePerMillion: 1, outputPricePerMillion: 2 }])
  })

  it('addAlias writes then reloads the alias list', async () => {
    const addModelAlias = vi.fn(() => Promise.resolve({ ok: true }))
    const getModelAliases = vi.fn(() => Promise.resolve([]))
    mockWindow({ addModelAlias, getModelAliases })

    const ok = await usePricingStore.getState().addAlias('foo', 'bar')
    expect(ok).toBe(true)
    expect(addModelAlias).toHaveBeenCalledWith('foo', 'bar')
    expect(getModelAliases).toHaveBeenCalledTimes(1)
  })

  it('addAlias surfaces a failed write and returns false', async () => {
    mockWindow({ addModelAlias: () => Promise.resolve({ ok: 'nope' }) })
    const ok = await usePricingStore.getState().addAlias('foo', 'bar')
    expect(ok).toBe(false)
    expect(usePricingStore.getState().error).toBeTruthy()
  })

  it('removeAlias removes then reloads', async () => {
    const removeModelAlias = vi.fn(() => Promise.resolve({ ok: true }))
    const getModelAliases = vi.fn(() => Promise.resolve([]))
    mockWindow({ removeModelAlias, getModelAliases })

    const ok = await usePricingStore.getState().removeAlias('foo')
    expect(ok).toBe(true)
    expect(removeModelAlias).toHaveBeenCalledWith('foo')
    expect(getModelAliases).toHaveBeenCalledTimes(1)
  })

  it('setOverride writes then reloads overrides', async () => {
    const setModelPrice = vi.fn(() => Promise.resolve({ ok: true }))
    const getPriceOverrides = vi.fn(() => Promise.resolve([]))
    mockWindow({ setModelPrice, getPriceOverrides })

    const ok = await usePricingStore.getState().setOverride('baz', 1, 2)
    expect(ok).toBe(true)
    expect(setModelPrice).toHaveBeenCalledWith('baz', 1, 2)
    expect(getPriceOverrides).toHaveBeenCalledTimes(1)
  })

  it('removeOverride removes then reloads', async () => {
    const removePriceOverride = vi.fn(() => Promise.resolve({ ok: true }))
    const getPriceOverrides = vi.fn(() => Promise.resolve([]))
    mockWindow({ removePriceOverride, getPriceOverrides })

    const ok = await usePricingStore.getState().removeOverride('baz')
    expect(ok).toBe(true)
    expect(removePriceOverride).toHaveBeenCalledWith('baz')
    expect(getPriceOverrides).toHaveBeenCalledTimes(1)
  })

  it('joins the shared refresh tick only after a list has been loaded', async () => {
    const getModelAliases = vi.fn(() => Promise.resolve([]))
    const getPriceOverrides = vi.fn(() => Promise.resolve([]))
    mockWindow({
      getScanStatus: () => Promise.resolve(statusScanned),
      getAnalytics: () => Promise.resolve(analytics),
      getModelAliases,
      getPriceOverrides,
    })

    // An unopened Aliases/Pricing panel never fetches on a scan.
    await useScanStore.getState().applyChange()
    expect(getModelAliases).not.toHaveBeenCalled()
    expect(getPriceOverrides).not.toHaveBeenCalled()

    await usePricingStore.getState().loadAliases()
    await usePricingStore.getState().loadOverrides()
    expect(getModelAliases).toHaveBeenCalledTimes(1)
    expect(getPriceOverrides).toHaveBeenCalledTimes(1)

    // Once loaded, both lists refetch on the next change.
    await useScanStore.getState().applyChange()
    expect(getModelAliases).toHaveBeenCalledTimes(2)
    expect(getPriceOverrides).toHaveBeenCalledTimes(2)
  })
})
