import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import type { LedgerViewData } from './view-read-projections.js'

/** Narrow facts shared by dashboard and analytics reads. */
export interface LedgerViewReadsPort {
  getViewData(): Effect.Effect<LedgerViewData, SqlError | Schema.SchemaError>
}

export class LedgerViewReads extends Context.Service<LedgerViewReads, LedgerViewReadsPort>()(
  'watchtower/store/LedgerViewReads',
) {}
