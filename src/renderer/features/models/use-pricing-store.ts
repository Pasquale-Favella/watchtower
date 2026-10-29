import { RegistryContext, useAtomSet, useAtomValue } from '@effect/atom-react'
import { useContext, useEffect } from 'react'

import { pinWindowAtom, useRemoteQuery } from '@/stores/hooks/use-remote-query'

import {
  aliasesPricingCommands,
  KNOWN_MODELS_REQUEST,
  pricedModelsAtom,
  PRICING_REQUEST,
  pricingAliasesQuery,
  pricingCommandErrorsAtom,
  pricingKnownModelsQuery,
  pricingOverridesQuery,
  pricingPaneCommands,
  quickAddPricingCommands,
  unpricedModelsAtom,
} from './pricing-atoms'

/** Pricing state and commands consumed by the aliases settings pane. */
export function useAliasPricingStore() {
  const registry = useContext(RegistryContext)
  useEffect(() => {
    pinWindowAtom(registry, aliasesPricingCommands.addAliasAtom)
    pinWindowAtom(registry, aliasesPricingCommands.removeAliasAtom)
  }, [registry])

  return {
    aliases: useRemoteQuery(pricingAliasesQuery, PRICING_REQUEST, () => 'aliases'),
    overrides: useRemoteQuery(pricingOverridesQuery, PRICING_REQUEST, () => 'overrides'),
    knownModels: useRemoteQuery(pricingKnownModelsQuery, KNOWN_MODELS_REQUEST, () => 'known-models'),
    addAlias: useAtomSet(aliasesPricingCommands.addAliasAtom, { mode: 'promise' }),
    removeAlias: useAtomSet(aliasesPricingCommands.removeAliasAtom, { mode: 'promise' }),
    commandErrors: useAtomValue(pricingCommandErrorsAtom),
    unpriced: useAtomValue(unpricedModelsAtom),
    priced: useAtomValue(pricedModelsAtom),
  }
}

/** Pricing state and commands consumed by the manual override pane. */
export function useOverridePricingStore() {
  const registry = useContext(RegistryContext)
  useEffect(() => {
    pinWindowAtom(registry, pricingPaneCommands.setOverrideAtom)
    pinWindowAtom(registry, pricingPaneCommands.removeOverrideAtom)
  }, [registry])

  return {
    overrides: useRemoteQuery(pricingOverridesQuery, PRICING_REQUEST, () => 'overrides'),
    aliases: useRemoteQuery(pricingAliasesQuery, PRICING_REQUEST, () => 'aliases'),
    knownModels: useRemoteQuery(pricingKnownModelsQuery, KNOWN_MODELS_REQUEST, () => 'known-models'),
    setOverride: useAtomSet(pricingPaneCommands.setOverrideAtom, { mode: 'promise' }),
    removeOverride: useAtomSet(pricingPaneCommands.removeOverrideAtom, { mode: 'promise' }),
    commandErrors: useAtomValue(pricingCommandErrorsAtom),
    unpriced: useAtomValue(unpricedModelsAtom),
  }
}

/** Pricing state and commands consumed by the model quick-add dialog. */
export function useQuickAddPricingStore() {
  const registry = useContext(RegistryContext)
  useEffect(() => {
    pinWindowAtom(registry, quickAddPricingCommands.addAliasAtom)
    pinWindowAtom(registry, quickAddPricingCommands.setOverrideAtom)
  }, [registry])

  return {
    aliases: useRemoteQuery(pricingAliasesQuery, PRICING_REQUEST, () => 'aliases'),
    overrides: useRemoteQuery(pricingOverridesQuery, PRICING_REQUEST, () => 'overrides'),
    addAlias: useAtomSet(quickAddPricingCommands.addAliasAtom, { mode: 'promise' }),
    setOverride: useAtomSet(quickAddPricingCommands.setOverrideAtom, { mode: 'promise' }),
  }
}
