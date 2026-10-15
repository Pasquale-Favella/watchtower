import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import { LedgerMaintenance } from './application/ledger-maintenance.js'

/** Uses the SQL client already owned by the worker runtime. */
export const LedgerMaintenanceLive = Layer.effect(
  LedgerMaintenance,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const reclaim = Effect.fn('LedgerMaintenance.reclaim')(function* (): Effect.fn.Return<void, SqlError> {
      yield* sql.unsafe('VACUUM')
      yield* sql.unsafe('PRAGMA wal_checkpoint(TRUNCATE)')
    })

    return LedgerMaintenance.of({ reclaim })
  }),
)
