import * as Effect from 'effect/Effect'

import {
  captureModelPricingCatalogue,
  createPricingConfigLookup,
  type PricingConfigLookup,
} from '../pipeline/models.js'
import type { PricingCatalogue } from '../pipeline/pricing-calculation.js'
import type {
  LedgerSessionRow,
  LedgerSourceRow,
  LedgerStore,
  LedgerTurnRow,
  ModelAlias,
  PriceOverride,
} from './ledger.js'
import type { LedgerCallFactsRow } from './read-projections.js'

/** All ledger and pricing inputs captured once for one view request. */
export type LedgerQuerySnapshot = {
  sources: readonly LedgerSourceRow[]
  sessions: readonly LedgerSessionRow[]
  turns: readonly LedgerTurnRow[]
  calls: readonly LedgerCallFactsRow[]
  pricing: PricingConfigLookup
  catalogue: PricingCatalogue
}

export function makeLedgerQuerySnapshot(input: {
  sources: readonly LedgerSourceRow[]
  sessions: readonly LedgerSessionRow[]
  turns: readonly LedgerTurnRow[]
  calls: readonly LedgerCallFactsRow[]
  aliases: readonly ModelAlias[]
  overrides: readonly PriceOverride[]
  catalogue: PricingCatalogue
}): LedgerQuerySnapshot {
  return {
    sources: input.sources,
    sessions: input.sessions,
    turns: input.turns,
    calls: input.calls,
    pricing: createPricingConfigLookup(input.aliases, input.overrides),
    catalogue: input.catalogue,
  }
}

/**
 * The temporary LedgerStore adapter for request-level queries. Bulk ledger
 * reads share one LedgerQueries transition; config is loaded once through its
 * own port. The calls remain synchronous on the owning thread.
 */
export function loadLedgerQuerySnapshot(store: LedgerStore): LedgerQuerySnapshot {
  const catalogue = captureModelPricingCatalogue()
  const rows = store.runQueriesSync(queries =>
    Effect.gen(function* () {
      const sources = yield* queries.getSources()
      const sessions = yield* queries.getSessions()
      const turns = yield* queries.getTurns()
      const calls = yield* queries.getCallFacts()
      return { sources, sessions, turns, calls }
    }),
  )
  const config = store.runRepositorySync(config =>
    Effect.gen(function* () {
      const aliases = yield* config.getModelAliases()
      const overrides = yield* config.getPriceOverrides()
      return { aliases, overrides }
    }),
  )
  return makeLedgerQuerySnapshot({ ...rows, ...config, catalogue })
}
