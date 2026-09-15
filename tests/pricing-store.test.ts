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

describe('usePricingStore (ADR 0011)', () => {
  it('starts with no aliases, overrides, or known models loaded', () => {
    const s = usePricingStore.getState()
    expect(s.aliases).toBeNull()
    expect(s.overrides).toBeNull()
    expect(s.knownModels).toBeNull()
    expect(s.unpriced).toEqual([])
    expect(s.priced).toEqual([])
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

  it('loads lifetime models and derives the priced/unpriced split', async () => {
    const pricedRow = {
      provider: 'openai',
      model: 'gpt-4o',
      modelDisplayName: 'GPT-4o',
      category: null,
      inputTokens: 100,
      outputTokens: 200,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 300,
      costUSD: 5,
      savingsUSD: 0,
      savingsBaselineModel: '',
      calls: 2,
    }
    const unpricedRow = { ...pricedRow, model: 'gpt-4o-mini', modelDisplayName: 'GPT-4o mini', costUSD: 0 }
    const savingsRow = { ...pricedRow, model: 'gpt-4.1', modelDisplayName: 'GPT-4.1', costUSD: 0, savingsUSD: 8 }

    mockWindow({
      getModels: () => Promise.resolve({ byModel: [pricedRow, unpricedRow, savingsRow], byTask: [], audit: [] }),
    })
    await usePricingStore.getState().loadKnownModels()

    const s = usePricingStore.getState()
    expect(s.knownModels).toEqual([pricedRow, unpricedRow, savingsRow])
    // The split is derived at load time and stored as stable references.
    // A savings-credited row (cost 0, savings > 0) is neither priced nor
    // unpriced — it never offers "add alias" (matches the Models view).
    expect(s.unpriced).toEqual([unpricedRow])
    expect(s.priced).toEqual([pricedRow])
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
    const getModels = vi.fn(() => Promise.resolve({ byModel: [], byTask: [], audit: [] }))
    mockWindow({
      getScanStatus: () => Promise.resolve(statusScanned),
      getAnalytics: () => Promise.resolve(analytics),
      getModelAliases,
      getPriceOverrides,
      getModels,
    })

    // An unopened Aliases/Pricing panel never fetches on a scan.
    await useScanStore.getState().applyChange()
    expect(getModelAliases).not.toHaveBeenCalled()
    expect(getPriceOverrides).not.toHaveBeenCalled()
    expect(getModels).not.toHaveBeenCalled()

    await usePricingStore.getState().loadAliases()
    await usePricingStore.getState().loadOverrides()
    await usePricingStore.getState().loadKnownModels()
    expect(getModelAliases).toHaveBeenCalledTimes(1)
    expect(getPriceOverrides).toHaveBeenCalledTimes(1)
    expect(getModels).toHaveBeenCalledTimes(1)

    // Once loaded, all three lists refetch on the next change.
    await useScanStore.getState().applyChange()
    expect(getModelAliases).toHaveBeenCalledTimes(2)
    expect(getPriceOverrides).toHaveBeenCalledTimes(2)
    expect(getModels).toHaveBeenCalledTimes(2)
  })

  it('an alias write refreshes aliases and derived usage lists together (no stale picker)', async () => {
    const getModelAliases = vi.fn(() => Promise.resolve([]))
    const getModels = vi.fn(() => Promise.resolve({ byModel: [], byTask: [], audit: [] }))
    const addModelAlias = vi.fn(() => Promise.resolve({ ok: true }))
    mockWindow({ addModelAlias, getModelAliases, getModels })

    await usePricingStore.getState().loadAliases()
    await usePricingStore.getState().loadKnownModels()
    expect(getModelAliases).toHaveBeenCalledTimes(1)
    expect(getModels).toHaveBeenCalledTimes(1)

    await usePricingStore.getState().addAlias('foo', 'bar')
    expect(addModelAlias).toHaveBeenCalledWith('foo', 'bar')
    // The write reloads the alias list AND the usage-derived pickers, so a
    // quick-add opened right after never proposes pre-write state.
    expect(getModelAliases).toHaveBeenCalledTimes(2)
    expect(getModels).toHaveBeenCalledTimes(2)
  })

  it('an alias removal refreshes aliases and derived usage lists together', async () => {
    const getModelAliases = vi.fn(() => Promise.resolve([]))
    const getModels = vi.fn(() => Promise.resolve({ byModel: [], byTask: [], audit: [] }))
    const removeModelAlias = vi.fn(() => Promise.resolve({ ok: true }))
    mockWindow({ removeModelAlias, getModelAliases, getModels })

    await usePricingStore.getState().loadAliases()
    await usePricingStore.getState().loadKnownModels()

    await usePricingStore.getState().removeAlias('foo')
    expect(removeModelAlias).toHaveBeenCalledWith('foo')
    expect(getModelAliases).toHaveBeenCalledTimes(2)
    expect(getModels).toHaveBeenCalledTimes(2)
  })

  it('an override write refreshes overrides and derived usage lists together', async () => {
    const getPriceOverrides = vi.fn(() => Promise.resolve([]))
    const getModels = vi.fn(() => Promise.resolve({ byModel: [], byTask: [], audit: [] }))
    const setModelPrice = vi.fn(() => Promise.resolve({ ok: true }))
    mockWindow({ setModelPrice, getPriceOverrides, getModels })

    await usePricingStore.getState().loadOverrides()
    await usePricingStore.getState().loadKnownModels()

    await usePricingStore.getState().setOverride('baz', 1, 2)
    expect(setModelPrice).toHaveBeenCalledWith('baz', 1, 2)
    expect(getPriceOverrides).toHaveBeenCalledTimes(2)
    expect(getModels).toHaveBeenCalledTimes(2)
  })

  it('an override removal refreshes overrides and derived usage lists together', async () => {
    const getPriceOverrides = vi.fn(() => Promise.resolve([]))
    const getModels = vi.fn(() => Promise.resolve({ byModel: [], byTask: [], audit: [] }))
    const removePriceOverride = vi.fn(() => Promise.resolve({ ok: true }))
    mockWindow({ removePriceOverride, getPriceOverrides, getModels })

    await usePricingStore.getState().loadOverrides()
    await usePricingStore.getState().loadKnownModels()

    await usePricingStore.getState().removeOverride('baz')
    expect(removePriceOverride).toHaveBeenCalledWith('baz')
    expect(getPriceOverrides).toHaveBeenCalledTimes(2)
    expect(getModels).toHaveBeenCalledTimes(2)
  })

  it('writes keep unopened usage lists lazy (no fetch when never loaded)', async () => {
    const getModelAliases = vi.fn(() => Promise.resolve([]))
    const getModels = vi.fn(() => Promise.resolve({ byModel: [], byTask: [], audit: [] }))
    const addModelAlias = vi.fn(() => Promise.resolve({ ok: true }))
    mockWindow({ addModelAlias, getModelAliases, getModels })

    await usePricingStore.getState().addAlias('foo', 'bar')
    expect(getModelAliases).toHaveBeenCalledTimes(1)
    expect(getModels).not.toHaveBeenCalled()
  })
})
