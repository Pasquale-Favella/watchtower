import { create } from 'zustand'
import {
  fetchAddModelAlias,
  fetchModelAliases,
  fetchModels,
  fetchPriceOverrides,
  fetchRemoveModelAlias,
  fetchRemovePriceOverride,
  fetchSetModelPrice,
} from '@/shared/lib/api'
import { isUnpriced } from '@/shared/lib/models'
import { subscribeToRefresh } from '../../app/stores/scan-store'
import type { ModelAlias, ModelReportRow, PriceOverride } from '../../../../shared/schemas/models.js'

/** Model aliases + price overrides, shared by Settings › Aliases/Pricing and
 * the Models quick-add. (ADR 0011) Writes go through the main process,
 * which broadcasts `config:changed`; the scan store's `applyChange` then
 * refetches the mounted view with the fresh query-time config. */
export interface PricingState {
  aliases: ModelAlias[] | null
  overrides: PriceOverride[] | null
  /** The models seen in usage (lifetime) — the "Recognized models" list the
   * Models quick-add popup shows, fetched lazily for the Settings pickers. */
  knownModels: ModelReportRow[] | null
  /** Derived from knownModels at load time: the usage models with no price
   * yet (ADR 0010 — zero cost AND zero savings) and the ones actually priced
   * (cost > 0). Stored as stable references so pickers can subscribe to them
   * directly — a computed selector would hand useSyncExternalStore a fresh
   * array every snapshot and loop. */
  unpriced: ModelReportRow[]
  priced: ModelReportRow[]
  error: string | null
  loadAliases: () => Promise<void>
  loadOverrides: () => Promise<void>
  loadKnownModels: () => Promise<void>
  addAlias: (model: string, aliasOf: string) => Promise<boolean>
  removeAlias: (model: string) => Promise<boolean>
  setOverride: (model: string, inputPricePerMillion: number, outputPricePerMillion: number) => Promise<boolean>
  removeOverride: (model: string) => Promise<boolean>
}

export const usePricingStore = create<PricingState>()((set, get) => ({
  aliases: null,
  overrides: null,
  knownModels: null,
  unpriced: [],
  priced: [],
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
  loadKnownModels: async () => {
    const result = await fetchModels({ period: 'lifetime' })
    if (result.ok) {
      const byModel = result.data?.byModel ?? []
      set({
        knownModels: byModel,
        unpriced: byModel.filter(isUnpriced),
        priced: byModel.filter(model => model.costUSD > 0),
        error: null,
      })
    } else {
      set({ error: result.error })
    }
  },
  addAlias: async (model, aliasOf) => {
    const result = await fetchAddModelAlias(model, aliasOf)
    if (!result.ok) {
      set({ error: result.error })
      return false
    }
    await afterWrite(get, 'aliases')
    return true
  },
  removeAlias: async (model) => {
    const result = await fetchRemoveModelAlias(model)
    if (!result.ok) {
      set({ error: result.error })
      return false
    }
    await afterWrite(get, 'aliases')
    return true
  },
  setOverride: async (model, inputPricePerMillion, outputPricePerMillion) => {
    const result = await fetchSetModelPrice(model, inputPricePerMillion, outputPricePerMillion)
    if (!result.ok) {
      set({ error: result.error })
      return false
    }
    await afterWrite(get, 'overrides')
    return true
  },
  removeOverride: async (model) => {
    const result = await fetchRemovePriceOverride(model)
    if (!result.ok) {
      set({ error: result.error })
      return false
    }
    await afterWrite(get, 'overrides')
    return true
  },
}))

/** Reload the written list plus the usage-derived picker lists after a
 * pricing write — but the usage lists only when already loaded, so a write
 * from an unopened panel never triggers a models fetch on its own. Without
 * this, pickers ("Already mapped", "Recognized models", Settings groups)
 * keep proposing pre-write state until the next refresh tick. */
async function afterWrite(get: () => PricingState, list: 'aliases' | 'overrides'): Promise<void> {
  await get()[list === 'aliases' ? 'loadAliases' : 'loadOverrides']()
  await refreshKnownModelsIfLoaded(get)
}

/** Re-read the usage-derived picker lists after a pricing write — but only
 * when already loaded, so a write from an unopened panel never triggers a
 * models fetch on its own. Without this, pickers ("Already mapped",
 * "Recognized models", Settings groups) keep proposing pre-write state
 * until the next refresh tick. */
async function refreshKnownModelsIfLoaded(get: () => PricingState): Promise<void> {
  if (get().knownModels !== null) await get().loadKnownModels()
}

// One of the data stores, so it joins the shared refresh tick (ADR 0011)
// — but lazily: a list is only refetched once it has been loaded, so an
// unopened Aliases/Pricing panel never fetches on a scan.
subscribeToRefresh(() => {
  const { aliases, overrides, knownModels, loadAliases, loadOverrides, loadKnownModels } = usePricingStore.getState()
  if (aliases !== null) void loadAliases()
  if (overrides !== null) void loadOverrides()
  if (knownModels !== null) void loadKnownModels()
})
