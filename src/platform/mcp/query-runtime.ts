import * as Sqlite from '@effect/sql-sqlite-node'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as SqlClient from 'effect/sql/SqlClient'

import { AssistantSetup } from '@/core/ports/assistant-setup.js'
import { queryLedgerMcpCalls, queryLedgerMcpScope } from '@/core/application/queries/ledger-mcp-query.js'
import { queryModelsView } from '@/core/application/queries/models-query.js'
import { queryOverview } from '@/core/application/queries/overview-query.js'
import { PricingDiagnostics } from '@/core/ports/pricing-diagnostics.js'
import { querySessionsView } from '@/core/application/queries/sessions-query.js'
import { querySkillsView } from '@/core/application/queries/skills-query.js'
import { AssistantSetupLive } from '@/infrastructure/services/assistant-setup-live.js'
import {
  captureLocalModelSavings,
  captureModelPricingCatalogue,
  captureProxyPaths,
} from '@/infrastructure/pricing/models.js'
import { PricingDiagnosticsLive } from '@/infrastructure/pricing/pricing-diagnostics.js'
import { LedgerExportReads } from '@/core/ports/ledger-export-reads.js'
import { LedgerConfig, LedgerIngest, LedgerQueries } from '@/core/ports/repository.js'
import { LedgerPortsLayer } from '@/infrastructure/sqlite/ledger-repository.js'
import { LedgerViewReads } from '@/core/ports/ledger-view-reads.js'
import type { LedgerMcpQueries } from '@/platform/mcp/query-api.js'

type LedgerMcpQueryRuntimeServices =
  | AssistantSetup
  | LedgerConfig
  | LedgerIngest
  | LedgerQueries
  | LedgerViewReads
  | LedgerExportReads
  | PricingDiagnostics
  | SqlClient.SqlClient
  | Sqlite.SqliteClient.SqliteClient

export async function createLedgerMcpQueryRuntime(dbPath: string): Promise<{
  queries: LedgerMcpQueries
  run: <A, E, R extends LedgerMcpQueryRuntimeServices>(effect: Effect.Effect<A, E, R>) => Promise<A>
  dispose: () => Promise<void>
}> {
  const sqlite = Sqlite.SqliteClient.layer({ filename: dbPath, readonly: true, disableWAL: true })
  const ledger = LedgerPortsLayer.pipe(Layer.provideMerge(sqlite))
  const runtime = ManagedRuntime.make(Layer.mergeAll(ledger, PricingDiagnosticsLive, AssistantSetupLive))

  try {
    await runtime.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql.unsafe('SELECT 1 FROM ledger_source LIMIT 0')
      }),
    )
  } catch (error) {
    await runtime.dispose()
    // Preserve the original rejection at this external Promise boundary.
    // eslint-disable-next-line no-restricted-syntax
    throw error
  }

  const snapshotInputs = () => ({ catalogue: captureModelPricingCatalogue(), proxyPaths: captureProxyPaths() })

  return {
    run: effect => runtime.runPromise(effect),
    queries: {
      scope: scope => runtime.runPromise(queryLedgerMcpScope({ ...snapshotInputs(), scope })),
      overview: scope =>
        runtime.runPromise(queryOverview({ ...snapshotInputs(), localSavings: captureLocalModelSavings(), scope })),
      sessions: scope => runtime.runPromise(querySessionsView({ ...snapshotInputs(), scope })),
      models: scope => runtime.runPromise(queryModelsView({ ...snapshotInputs(), scope })),
      skills: scope => runtime.runPromise(querySkillsView({ ...snapshotInputs(), scope })),
      calls: input => runtime.runPromise(queryLedgerMcpCalls({ ...snapshotInputs(), ...input })),
    },
    dispose: () => runtime.dispose(),
  }
}
