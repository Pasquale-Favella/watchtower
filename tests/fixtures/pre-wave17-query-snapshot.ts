/** Frozen snapshot adapter used only by the independent legacy view oracle. */
import * as Effect from 'effect/Effect'

import { captureModelPricingCatalogue, captureProxyPaths } from '../../src/infrastructure/pricing/models.js'
import type { LedgerConfigPort, LedgerQueriesPort } from '../../src/core/ports/repository.js'
import {
  type LedgerQuerySnapshot,
  makeLedgerQuerySnapshot,
} from '../../src/core/application/queries/ledger-query-snapshot.js'

export type { LedgerQuerySnapshot }

/** Only the native reads consumed by the frozen calculation oracle. */
export interface LegacyLedgerReader {
  runQueriesSync<A, E>(operation: (queries: LedgerQueriesPort) => Effect.Effect<A, E>): A
  runRepositorySync<A, E>(operation: (config: LedgerConfigPort) => Effect.Effect<A, E>): A
}

export function loadLedgerQuerySnapshot(store: LegacyLedgerReader): LedgerQuerySnapshot {
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
