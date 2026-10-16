import * as Effect from 'effect/Effect'

import type { LedgerSessionRow, LedgerSourceRow, LedgerTurnRow } from '../../shared/schemas/ledger.js'
import {
  createPricingConfigLookup,
  type PricingCatalogue,
  type PricingConfigLookup,
} from '../pipeline/pricing-calculation.js'
import type { ProxyPathConfig } from '../pipeline/proxy-paths.js'
import { LedgerQueries, type LedgerRequestSnapshotData } from './ledger-ports.js'
import type { LedgerCallFactsRow } from './read-projections.js'

/** The immutable inputs captured for one request-level ledger calculation. */
export type LedgerQuerySnapshot = {
  sources: readonly LedgerSourceRow[]
  sessions: readonly LedgerSessionRow[]
  turns: readonly LedgerTurnRow[]
  calls: readonly LedgerCallFactsRow[]
  aliases: readonly LedgerRequestSnapshotData['aliases'][number][]
  overrides: readonly LedgerRequestSnapshotData['overrides'][number][]
  pricing: PricingConfigLookup
  catalogue: PricingCatalogue
  proxyPaths: ProxyPathConfig
}

export type LedgerQuerySnapshotInputs = LedgerRequestSnapshotData & {
  catalogue: PricingCatalogue
  proxyPaths: ProxyPathConfig
}

export function makeLedgerQuerySnapshot(input: LedgerQuerySnapshotInputs): LedgerQuerySnapshot {
  return {
    sources: input.sources,
    sessions: input.sessions,
    turns: input.turns,
    calls: input.calls,
    aliases: input.aliases,
    overrides: input.overrides,
    pricing: createPricingConfigLookup(input.aliases, input.overrides),
    catalogue: input.catalogue,
    proxyPaths: Object.freeze({
      paths: Object.freeze([...input.proxyPaths.paths]),
      caseSensitive: input.proxyPaths.caseSensitive,
    }),
  }
}

/** Load decoded facts and explicitly captured application config for a request. */
export const loadLedgerQuerySnapshotEffect = Effect.fn('LedgerQuerySnapshot.load')(function* (input: {
  catalogue: PricingCatalogue
  proxyPaths: ProxyPathConfig
}) {
  const queries = yield* LedgerQueries
  const data: LedgerRequestSnapshotData = yield* queries.getRequestSnapshotData()
  return makeLedgerQuerySnapshot({ ...data, ...input })
})
