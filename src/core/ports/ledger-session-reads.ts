import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/sql/SqlError'

import type { LedgerRequestSnapshotData } from '@/core/ports/repository.js'
import type { SessionSearchData, SessionSummaryData } from '@/core/analytics/projections/session-read-projections.js'

/** Purpose-shaped reads for the worker's project and session routes. */
export interface LedgerSessionReadsPort {
  getSessionSummaryData(): Effect.Effect<SessionSummaryData, SqlError | Schema.SchemaError>
  getSessionDetailData(
    publicSessionId: string,
    sourceId?: number,
  ): Effect.Effect<LedgerRequestSnapshotData, SqlError | Schema.SchemaError>
  getSessionSearchData(): Effect.Effect<SessionSearchData, SqlError | Schema.SchemaError>
}

export class LedgerSessionReads extends Context.Service<LedgerSessionReads, LedgerSessionReadsPort>()(
  'watchtower/store/LedgerSessionReads',
) {}
