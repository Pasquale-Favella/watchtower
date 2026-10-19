import * as Layer from 'effect/Layer'
import * as SqlClient from 'effect/sql/SqlClient'

import { LedgerConfigLive } from './ledger-config-live.js'
import { LedgerExportReads } from './ledger-export-reads.js'
import { LedgerExportReadsLive } from './ledger-export-reads-live.js'
import { LedgerIngestLive } from './ledger-ingest-live.js'
import { LedgerConfig, LedgerIngest, LedgerQueries } from './ledger-ports.js'
import { LedgerQueriesLive } from './ledger-queries-live.js'
import { LedgerSessionReads } from './ledger-session-reads.js'
import { LedgerSessionReadsLive } from './ledger-session-reads-live.js'
import { LedgerViewReads } from './ledger-view-reads.js'
import { LedgerViewReadsLive } from './ledger-view-reads-live.js'

export { LedgerExportReads, type LedgerExportReadsPort } from './ledger-export-reads.js'
export {
  LedgerConfig,
  type LedgerConfigPort,
  LedgerIngest,
  type LedgerIngestPort,
  LedgerQueries,
  type LedgerQueriesPort,
  type LedgerRequestSnapshotData,
} from './ledger-ports.js'
export { LedgerSessionReads, type LedgerSessionReadsPort } from './ledger-session-reads.js'
export { LedgerViewReads, type LedgerViewReadsPort } from './ledger-view-reads.js'

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
