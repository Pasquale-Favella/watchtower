import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { SqlError } from 'effect/unstable/sql/SqlError'

/** Physical maintenance for the existing ledger database. */
export interface LedgerMaintenancePort {
  reclaim(): Effect.Effect<void, SqlError>
}

export class LedgerMaintenance extends Context.Service<LedgerMaintenance, LedgerMaintenancePort>()(
  'watchtower/application/LedgerMaintenance',
) {}
