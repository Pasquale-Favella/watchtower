import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/sql/SqlClient'

import { LedgerConfigLive } from '@/infrastructure/sqlite/ledger-config-live.js'
import { LedgerExportReads } from '@/core/ports/ledger-export-reads.js'
import { LedgerExportReadsLive } from '@/infrastructure/sqlite/ledger-export-reads-live.js'
import { LedgerIngestLive } from '@/infrastructure/sqlite/ledger-ingest-live.js'
import { LedgerConfig, LedgerIngest, LedgerQueries } from '@/core/ports/repository.js'
import { LedgerQueriesLive } from '@/infrastructure/sqlite/ledger-queries-live.js'
import { LedgerSessionReads } from '@/core/ports/ledger-session-reads.js'
import { LedgerSessionReadsLive } from '@/infrastructure/sqlite/ledger-session-reads-live.js'
import { LedgerViewReads } from '@/core/ports/ledger-view-reads.js'
import { LedgerViewReadsLive } from '@/infrastructure/sqlite/ledger-view-reads-live.js'

export { LedgerExportReads, type LedgerExportReadsPort } from '@/core/ports/ledger-export-reads.js'
export {
  LedgerConfig,
  type LedgerConfigPort,
  LedgerIngest,
  type LedgerIngestPort,
  LedgerQueries,
  type LedgerQueriesPort,
  type LedgerRequestSnapshotData,
} from '@/core/ports/repository.js'
export { LedgerSessionReads, type LedgerSessionReadsPort } from '@/core/ports/ledger-session-reads.js'
export { LedgerViewReads, type LedgerViewReadsPort } from '@/core/ports/ledger-view-reads.js'

/** All ledger capabilities over the caller-owned SqlClient; no connection is created here. */
export const LedgerPortsLayer: Layer.Layer<
  LedgerIngest | LedgerQueries | LedgerConfig | LedgerSessionReads | LedgerViewReads | LedgerExportReads,
  never,
  SqlClient.SqlClient
> = Layer.mergeAll(
  LedgerIngestLive,
  LedgerQueriesLive,
  LedgerConfigLive,
  LedgerSessionReadsLive,
  LedgerViewReadsLive,
  LedgerExportReadsLive,
)
