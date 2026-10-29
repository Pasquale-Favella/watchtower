import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/sql/SqlError'

import type { DateRange } from '../domain/observations/types.js'
import type { OverviewReadData } from '../analytics/projections/overview-read-projections.js'
import type { LedgerViewData } from '../analytics/projections/view-read-projections.js'

/** Narrow facts shared by dashboard and analytics reads. */
export interface LedgerViewReadsPort {
  getViewData(): Effect.Effect<LedgerViewData, SqlError | Schema.SchemaError>
  /** Minimal, request-fresh facts for the Overview Section. */
  getOverviewData(range?: DateRange): Effect.Effect<OverviewReadData, SqlError | Schema.SchemaError>
}

export class LedgerViewReads extends Context.Service<LedgerViewReads, LedgerViewReadsPort>()(
  'watchtower/store/LedgerViewReads',
) {}
