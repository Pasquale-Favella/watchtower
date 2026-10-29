import * as Effect from 'effect/Effect'

import type { LedgerSessionRow, LedgerSourceRow, LedgerTurnRow } from '@/shared/schemas/ledger.js'
import {
  createPricingConfigLookup,
  type PricingCatalogue,
  type PricingConfigLookup,
} from '@/core/domain/pricing/pricing-calculation.js'
import type { ProxyPathConfig } from '@/core/domain/sessions/proxy-paths.js'
import type { DateRange } from '@/core/domain/observations/types.js'
import { LedgerQueries, type LedgerRequestSnapshotData } from '@/core/ports/repository.js'
import type { LedgerCallDiagnosticsRow, LedgerCallFactsRow } from '@/core/analytics/projections/read-projections.js'

/** The immutable inputs captured for one request-level ledger calculation. */
export type LedgerQuerySnapshot = {
  sources: readonly LedgerSourceRow[]
  sessions: readonly LedgerSessionRow[]
  turns: readonly LedgerTurnRow[]
  calls: readonly LedgerCallFactsRow[]
  callDiagnostics?: readonly LedgerCallDiagnosticsRow[]
  aliases: readonly LedgerRequestSnapshotData['aliases'][number][]
  overrides: readonly LedgerRequestSnapshotData['overrides'][number][]
  lifetimeModels?: readonly NonNullable<LedgerRequestSnapshotData['lifetimeModels']>[number][]
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
    ...(input.callDiagnostics ? { callDiagnostics: input.callDiagnostics } : {}),
    aliases: input.aliases,
    overrides: input.overrides,
    ...(input.lifetimeModels ? { lifetimeModels: input.lifetimeModels } : {}),
    pricing: createPricingConfigLookup(input.aliases, input.overrides),
    catalogue: input.catalogue,
    proxyPaths: Object.freeze({
      paths: Object.freeze([...input.proxyPaths.paths]),
      caseSensitive: input.proxyPaths.caseSensitive,
    }),
  }
}

/** Load decoded facts and explicitly captured application config for a request. */
export const loadLedgerQuerySnapshotEffect = Effect.fn('LedgerQuerySnapshot.load')(function* (
  input: {
    catalogue: PricingCatalogue
    proxyPaths: ProxyPathConfig
  },
  range?: DateRange,
  includeCallDiagnostics = false,
) {
  const queries = yield* LedgerQueries
  const data: LedgerRequestSnapshotData = yield* includeCallDiagnostics
    ? queries.getRequestSnapshotData(range, true)
    : queries.getRequestSnapshotData(range)
  return makeLedgerQuerySnapshot({ ...data, ...input })
})
