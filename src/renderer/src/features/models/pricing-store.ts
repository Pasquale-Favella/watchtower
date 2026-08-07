import { create } from 'zustand'
import {
  fetchAddModelAlias,
  fetchModelAliases,
  fetchPriceOverrides,
  fetchRemoveModelAlias,
  fetchRemovePriceOverride,
  fetchSetModelPrice,
} from '@/shared/lib/api'
import { subscribeToRefresh } from '../../app/stores/scan-store'
import type { ModelAlias, PriceOverride } from '../../../../shared/schemas/models.js'

/** Model aliases + price overrides, shared by Settings › Aliases/Pricing and
 * the Models quick-add. (map ticket 02) Writes go through the main process,
 * which broadcasts `config:changed`; the scan store's `applyChange` then
 * refetches the mounted view with the fresh query-time config. */
export interface PricingState {
  aliases: ModelAlias[] | null
  overrides: PriceOverride[] | null
  error: string | null
  loadAliases: () => Promise<void>
  loadOverrides: () => Promise<void>
  addAlias: (model: string, aliasOf: string) => Promise<boolean>
  removeAlias: (model: string) => Promise<boolean>
  setOverride: (model: string, inputPricePerMillion: number, outputPricePerMillion: number) => Promise<boolean>
  removeOverride: (model: string) => Promise<boolean>
}

export const usePricingStore = create<PricingState>()((set, get) => ({
  aliases: null,
  overrides: null,
  error: null,
  loadAliases: async () => {
    const result = await fetchModelAliases()
    if (result.ok) set({ aliases: result.data, error: null })
    else set({ error: result.error })
  },
  loadOverrides: async () => {
    const result = await fetchPriceOverrides()
    if (result.ok) set({ overrides: result.data, error: null })
    else set({ error: result.error })
  },
  addAlias: async (model, aliasOf) => {
    const result = await fetchAddModelAlias(model, aliasOf)
    if (!result.ok) {
      set({ error: result.error })
      return false
    }
    await get().loadAliases()
    return true
  },
  removeAlias: async (model) => {
    const result = await fetchRemoveModelAlias(model)
    if (!result.ok) {
      set({ error: result.error })
      return false
    }
    await get().loadAliases()
    return true
  },
  setOverride: async (model, inputPricePerMillion, outputPricePerMillion) => {
    const result = await fetchSetModelPrice(model, inputPricePerMillion, outputPricePerMillion)
    if (!result.ok) {
      set({ error: result.error })
      return false
    }
    await get().loadOverrides()
    return true
  },
  removeOverride: async (model) => {
    const result = await fetchRemovePriceOverride(model)
    if (!result.ok) {
      set({ error: result.error })
      return false
    }
    await get().loadOverrides()
    return true
  },
}))

// One of the data stores, so it joins the shared refresh tick (map ticket 02)
// — but lazily: a list is only refetched once it has been loaded, so an
// unopened Aliases/Pricing panel never fetches on a scan.
subscribeToRefresh(() => {
  const { aliases, overrides, loadAliases, loadOverrides } = usePricingStore.getState()
  if (aliases !== null) void loadAliases()
  if (overrides !== null) void loadOverrides()
})
