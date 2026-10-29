import * as Effect from 'effect/Effect'
import type { SqlError } from 'effect/sql/SqlError'

import { LedgerIngest } from '../../ports/repository.js'
import { LedgerMaintenance } from '../../ports/ledger-maintenance.js'

/** Clears scan facts, then best-effort reclaims their physical storage. */
export const clearLedger = Effect.fn('clearLedger')(function* (): Effect.fn.Return<
  void,
  SqlError,
  LedgerIngest | LedgerMaintenance
> {
  const ingest = yield* LedgerIngest
  yield* ingest.clear()

  const maintenance = yield* LedgerMaintenance
  yield* maintenance.reclaim().pipe(Effect.catchTag('SqlError', () => Effect.void))
})
