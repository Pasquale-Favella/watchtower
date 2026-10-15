import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type * as Schema from 'effect/Schema'
import type { SqlError } from 'effect/unstable/sql/SqlError'

import type { LedgerExportData } from './export-read-projections.js'

export interface LedgerExportReadsPort {
  getExportData(): Effect.Effect<LedgerExportData, SqlError | Schema.SchemaError>
}

export class LedgerExportReads extends Context.Service<LedgerExportReads, LedgerExportReadsPort>()(
  'watchtower/store/LedgerExportReads',
) {}
