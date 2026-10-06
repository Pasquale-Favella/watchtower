import * as Effect from 'effect/Effect'

import { PricingDiagnostics } from '../../src/main/application/pricing-diagnostics.js'
import { querySessionDetail } from '../../src/main/application/session-detail-query.js'
import { querySessionSearch } from '../../src/main/application/session-search-query.js'
import { queryProjectRows, querySessionRows } from '../../src/main/application/store-row-queries.js'
import { captureModelPricingCatalogue, captureProxyPaths } from '../../src/main/pipeline/models.js'
import type { LedgerStore } from '../../src/main/store/ledger.js'

const catalogue = captureModelPricingCatalogue()
const diagnostics = PricingDiagnostics.of({ reportUnpricedModels: () => Effect.void })
const proxyPaths = captureProxyPaths()

export function projectRows(store: LedgerStore) {
  return Effect.runPromise(
    queryProjectRows({ catalogue }).pipe(
      Effect.provideService(PricingDiagnostics, diagnostics),
      Effect.provide(store.portsLayer),
    ),
  )
}

export function sessionRows(store: LedgerStore, filter: { project?: string; since?: string; until?: string } = {}) {
  return Effect.runPromise(
    querySessionRows({ catalogue, filter }).pipe(
      Effect.provideService(PricingDiagnostics, diagnostics),
      Effect.provide(store.portsLayer),
    ),
  )
}

export function sessionDetail(store: LedgerStore, sessionId: string) {
  return Effect.runPromise(
    querySessionDetail({ catalogue, proxyPaths, sessionId }).pipe(
      Effect.provideService(PricingDiagnostics, diagnostics),
      Effect.provide(store.portsLayer),
    ),
  )
}

export function sessionSearch(store: LedgerStore, query: string) {
  return Effect.runPromise(querySessionSearch({ catalogue, query }).pipe(Effect.provide(store.portsLayer)))
}
