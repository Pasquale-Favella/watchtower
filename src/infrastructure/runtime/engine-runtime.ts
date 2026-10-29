import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import * as Sqlite from '@effect/sql-sqlite-node'
import * as Effect from 'effect/Effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as SqlClient from 'effect/sql/SqlClient'
import type { SqlError } from 'effect/sql/SqlError'

import { AssistantSetup } from '../../core/ports/assistant-setup.js'
import { ExportFiles } from '../../core/ports/export-files.js'
import { GatewayReports } from '../../core/ports/gateway-reports.js'
import { ScanSources } from '../../core/ports/ingestion.js'
import { LedgerMaintenance } from '../../core/ports/ledger-maintenance.js'
import { PricingDiagnostics } from '../../core/ports/pricing-diagnostics.js'
import { CommandRunner } from '../../core/ports/process.js'
import { RepositoryInspection } from '../../core/ports/repository-inspection.js'
import { Env } from '../config/environment.js'
import { HttpFetch } from '../ingestion/fetch-utils.js'
import { ScanSourcesLive } from '../ingestion/scan-sources-live.js'
import {
  OperationalLog,
  OperationalLogLoggerLayer,
  operationalLogLoggerLayerWithSink,
  OperationalLogMetricLayer,
  type OperationalLogSink,
  OperationalLogTracerLayer,
} from '../logging/operational-log.js'
import { NodePlatformLive, type NodePlatformServices } from '../platform/platform-live.js'
import { FxRates } from '../pricing/fx.js'
import { PricingDiagnosticsLive } from '../pricing/pricing-diagnostics.js'
import { CommandRunnerLive } from '../process/command-runner.js'
import { AssistantSetupLive } from '../services/assistant-setup-live.js'
import { ExportFilesLive } from '../services/export-files-live.js'
import { GatewayReportsLive } from '../services/gateway-reports-live.js'
import { LedgerMaintenanceLive } from '../services/ledger-maintenance-live.js'
import { RepositoryInspectionLive } from '../services/repository-inspection-live.js'
import { initializeLedger } from '../sqlite/ledger-initialization.js'
import {
  LedgerConfig,
  LedgerExportReads,
  LedgerIngest,
  LedgerPortsLayer,
  LedgerQueries,
  LedgerSessionReads,
  LedgerViewReads,
} from '../sqlite/ledger-repository.js'

export type EngineServices =
  | ScanSources
  | NodePlatformServices
  | AssistantSetup
  | ExportFiles
  | GatewayReports
  | RepositoryInspection
  | CommandRunner
  | PricingDiagnostics
  | OperationalLog
  | Env
  | HttpFetch
  | FxRates
  | LedgerIngest
  | LedgerQueries
  | LedgerSessionReads
  | LedgerViewReads
  | LedgerExportReads
  | LedgerConfig
  | LedgerMaintenance
  | Sqlite.SqliteClient.SqliteClient
  | SqlClient.SqlClient
export type EngineOverrides =
  | ScanSources
  | NodePlatformServices
  | OperationalLog
  | Env
  | HttpFetch
  | FxRates
  | LedgerIngest
  | LedgerQueries
  | LedgerSessionReads
  | LedgerViewReads
  | LedgerExportReads
  | LedgerConfig
  | PricingDiagnostics
  | AssistantSetup
  | RepositoryInspection
  | CommandRunner
  | ExportFiles
  | GatewayReports
  | LedgerMaintenance
export type EngineSqlLayer = Layer.Layer<Sqlite.SqliteClient.SqliteClient | SqlClient.SqlClient, SqlError>
export type EngineRuntime = ManagedRuntime.ManagedRuntime<EngineServices, SqlError>

/** Worker root owns one SQL client and composes every ledger port over it. */
export function makeEngineLive<Overrides extends EngineOverrides = never>(
  dbPath: string,
  sink?: OperationalLogSink,
  overrides?: Layer.Layer<Overrides>,
  sqliteLayer: EngineSqlLayer = Sqlite.SqliteClient.layer({ filename: dbPath }),
): Layer.Layer<EngineServices, SqlError> {
  const ledger = LedgerPortsLayer.pipe(Layer.provideMerge(sqliteLayer))
  const liveFetch = HttpFetch.layer.pipe(Layer.provide(FetchHttpClient.layer))
  const platform = overrides ? Layer.merge(NodePlatformLive, overrides) : NodePlatformLive
  const commandRunner = CommandRunnerLive.pipe(Layer.provide(platform))
  // Put the merged platform/override layer after defaults so its services win
  // collisions. CommandRunner captures this same layer; the other adapters
  // receive the completed capability graph below.
  const log = sink ? OperationalLog.layerWithSink(sink, 'worker') : OperationalLog.layer
  const capabilities = Layer.mergeAll(ledger, log, AssistantSetupLive, commandRunner, Env.layer, liveFetch, platform)
  const exportFiles = ExportFilesLive.pipe(Layer.provide(capabilities))
  const fxRates = FxRates.layer.pipe(Layer.provide(capabilities))
  const repositoryInspection = RepositoryInspectionLive.pipe(Layer.provide(capabilities))
  const gatewayReports = GatewayReportsLive.pipe(Layer.provide(capabilities))
  const maintenance = LedgerMaintenanceLive.pipe(Layer.provide(capabilities))
  const scanSources = ScanSourcesLive.pipe(Layer.provide(capabilities))

  const live = Layer.mergeAll(
    OperationalLogMetricLayer,
    sink ? operationalLogLoggerLayerWithSink(sink, 'worker') : OperationalLogLoggerLayer,
    OperationalLogTracerLayer('worker', sink),
    PricingDiagnosticsLive,
    exportFiles,
    fxRates,
    repositoryInspection,
    gatewayReports,
    maintenance,
    scanSources,
    capabilities,
  )
  return live
}

export function makeEngineRuntime(
  dbPath: string,
  layer: Layer.Layer<EngineServices, SqlError> = makeEngineLive(dbPath),
): EngineRuntime {
  return ManagedRuntime.make(layer)
}

/**
 * Initializes the worker's one SQL client before the worker can publish ready.
 * Failed boot disposes that runtime and preserves the initialization failure.
 */
export function openEngineRuntime<Overrides extends EngineOverrides = never>(
  dbPath: string,
  sink?: OperationalLogSink,
  overrides?: Layer.Layer<Overrides>,
  options: {
    readonly sqliteLayer?: EngineSqlLayer
    readonly makeRuntime?: typeof makeEngineRuntime
  } = {},
): EngineRuntime {
  mkdirSync(dirname(dbPath), { recursive: true })
  const layer = makeEngineLive(dbPath, sink, overrides, options.sqliteLayer)
  const runtime = (options.makeRuntime ?? makeEngineRuntime)(dbPath, layer)
  try {
    runtime.runSync(initializeLedger)
    return runtime
  } catch (error) {
    try {
      Effect.runSync(runtime.disposeEffect)
    } catch {
      // Preserve the initialization failure as the boot error.
    }
    throw error
  }
}
