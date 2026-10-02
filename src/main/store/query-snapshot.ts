import * as Effect from 'effect/Effect'

import { captureModelPricingCatalogue, captureProxyPaths } from '../pipeline/models.js'
import type { LedgerStore } from './ledger.js'
import {
  type LedgerQuerySnapshot,
  type LedgerQuerySnapshotInputs,
  makeLedgerQuerySnapshot,
} from './ledger-query-snapshot.js'

export { makeLedgerQuerySnapshot }
export type { LedgerQuerySnapshot, LedgerQuerySnapshotInputs }

/**
 * Temporary LedgerStore compatibility adapter for legacy view callers.
 * Removal condition: delete after every caller loads through the application
 * Effect runtime with request-captured catalogue and proxy paths.
 */
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
