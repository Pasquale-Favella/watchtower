import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import type { LedgerRequestSnapshotData } from './ledger-ports.js'
import type { SessionSearchData, SessionSummaryData } from './session-read-projections.js'

/** Purpose-shaped reads for the worker's project and session routes. */
export interface LedgerSessionReadsPort {
  getSessionSummaryData(): Effect.Effect<SessionSummaryData, SqlError | Schema.SchemaError>
  getSessionDetailData(publicSessionId: string): Effect.Effect<LedgerRequestSnapshotData, SqlError | Schema.SchemaError>
  getSessionSearchData(): Effect.Effect<SessionSearchData, SqlError | Schema.SchemaError>
}

export class LedgerSessionReads extends Context.Service<LedgerSessionReads, LedgerSessionReadsPort>()(
  'watchtower/store/LedgerSessionReads',
) {}
