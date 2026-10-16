import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as Sqlite from '@effect/sql-sqlite-node'
import * as Effect from 'effect/Effect'
import type * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as SqlClient from 'effect/sql/SqlClient'
import type { SqlError } from 'effect/sql/SqlError'

import { CommandRunner } from './agents/command-runner.js'
import { AssistantSetup } from './application/assistant-setup.js'
import { ExportFiles } from './application/export-files.js'
import { GatewayReports } from './application/gateway-reports.js'
import { LedgerMaintenance } from './application/ledger-maintenance.js'
import { PricingDiagnostics } from './application/pricing-diagnostics.js'
import { RepositoryInspection } from './application/repository-inspection.js'
import { AssistantSetupLive } from './assistant-setup-live.js'
import { Env } from './env.js'
import { ExportFilesLive } from './export-files-live.js'
import { FxRates } from './fx.js'
import { GatewayReportsLive } from './gateway-reports-live.js'
import { LedgerMaintenanceLive } from './ledger-maintenance-live.js'
import {
  OperationalLog,
  OperationalLogLoggerLayer,
  operationalLogLoggerLayerWithSink,
  OperationalLogMetricLayer,
  type OperationalLogSink,
  OperationalLogTracerLayer,
} from './operational-log.js'
import { HttpFetch } from './pipeline/fetch-utils.js'
import { PricingDiagnosticsLive } from './pipeline/pricing-diagnostics.js'
import { RepositoryInspectionLive } from './repository-inspection-live.js'
import { initializeLedger } from './store/ledger-initialization.js'
import {
  LedgerConfig,
  LedgerExportReads,
  LedgerIngest,
  LedgerPortsLayer,
  LedgerQueries,
  LedgerSessionReads,
  LedgerViewReads,
} from './store/ledger-repository.js'

export type WorkerServices =
  | FileSystem.FileSystem
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
export type WorkerOverrides =
  | FileSystem.FileSystem
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
export type WorkerSqlLayer = Layer.Layer<Sqlite.SqliteClient.SqliteClient | SqlClient.SqlClient, SqlError>
export type WorkerRuntime = ManagedRuntime.ManagedRuntime<WorkerServices, SqlError>

/** Worker root owns one SQL client and composes every ledger port over it. */
export function makeWorkerLive<Overrides extends WorkerOverrides = never>(
  dbPath: string,
  sink?: OperationalLogSink,
  overrides?: Layer.Layer<Overrides>,
  sqliteLayer: WorkerSqlLayer = Sqlite.SqliteClient.layer({ filename: dbPath }),
): Layer.Layer<WorkerServices, SqlError> {
  const ledger = LedgerPortsLayer.pipe(Layer.provideMerge(sqliteLayer))
  const liveFetch = HttpFetch.layerWithFetch((input, init) => globalThis.fetch(input, init))
  const capabilities = Layer.mergeAll(
    ledger,
    AssistantSetupLive,
    NodeFileSystem.layer,
    CommandRunner.layer,
    Env.layer,
    liveFetch,
  )
  const dependencies = overrides ? Layer.mergeAll(capabilities, overrides) : capabilities
  const exportFiles = ExportFilesLive.pipe(Layer.provide(dependencies))
  const fxRates = FxRates.layer.pipe(Layer.provide(dependencies))
  const repositoryInspection = RepositoryInspectionLive.pipe(Layer.provide(dependencies))
  const gatewayReports = GatewayReportsLive.pipe(Layer.provide(dependencies))
  const maintenance = LedgerMaintenanceLive.pipe(Layer.provide(dependencies))

  const live = Layer.mergeAll(
    OperationalLogMetricLayer,
    sink ? operationalLogLoggerLayerWithSink(sink, 'worker') : OperationalLogLoggerLayer,
    OperationalLogTracerLayer('worker', sink),
    sink ? OperationalLog.layerWithSink(sink, 'worker') : OperationalLog.layer,
    PricingDiagnosticsLive,
    exportFiles,
    fxRates,
    repositoryInspection,
    gatewayReports,
    maintenance,
    dependencies,
  )
  return overrides ? Layer.mergeAll(live, overrides) : live
}

export function makeWorkerRuntime(
  dbPath: string,
  layer: Layer.Layer<WorkerServices, SqlError> = makeWorkerLive(dbPath),
): WorkerRuntime {
  return ManagedRuntime.make(layer)
}

/**
 * Initializes the worker's one SQL client before the worker can publish ready.
 * Failed boot disposes that runtime and preserves the initialization failure.
 */
export function openWorkerRuntime<Overrides extends WorkerOverrides = never>(
  dbPath: string,
  sink?: OperationalLogSink,
  overrides?: Layer.Layer<Overrides>,
  options: {
    readonly sqliteLayer?: WorkerSqlLayer
    readonly makeRuntime?: typeof makeWorkerRuntime
  } = {},
): WorkerRuntime {
  mkdirSync(dirname(dbPath), { recursive: true })
  const layer = makeWorkerLive(dbPath, sink, overrides, options.sqliteLayer)
  const runtime = (options.makeRuntime ?? makeWorkerRuntime)(dbPath, layer)
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
