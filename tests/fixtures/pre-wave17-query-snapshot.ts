/** Frozen snapshot adapter used only by the independent legacy view oracle. */
import * as Effect from 'effect/Effect'

import { captureModelPricingCatalogue, captureProxyPaths } from '../../src/main/pipeline/models.js'
import type { LedgerStore } from '../../src/main/store/ledger.js'
import { type LedgerQuerySnapshot, makeLedgerQuerySnapshot } from '../../src/main/store/ledger-query-snapshot.js'

export type { LedgerQuerySnapshot }

export function loadLedgerQuerySnapshot(store: LedgerStore): LedgerQuerySnapshot {
  const inputs = {
    catalogue: captureModelPricingCatalogue(),
    proxyPaths: captureProxyPaths(),
  }
  const data = store.runQueriesSync(queries =>
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
  return makeLedgerQuerySnapshot({ ...data, ...config, ...inputs })
}
