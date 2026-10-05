import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import * as Sqlite from '@effect/sql-sqlite-node'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

import { CommandRunner } from './agents/command-runner.js'
import { AssistantSetup } from './application/assistant-setup.js'
import { ExportFiles } from './application/export-files.js'
import { PricingDiagnostics } from './application/pricing-diagnostics.js'
import { RepositoryInspection } from './application/repository-inspection.js'
import { AssistantSetupLive } from './assistant-setup-live.js'
import { Env } from './env.js'
import { ExportFilesLive } from './export-files-live.js'
import { FxRates } from './fx.js'
import {
  OperationalLog,
  OperationalLogLoggerLayer,
  operationalLogLoggerLayerWithSink,
  type OperationalLogSink,
  OperationalLogTracerLayer,
} from './operational-log.js'
import { HttpFetch } from './pipeline/fetch-utils.js'
import { PricingDiagnosticsLive } from './pipeline/pricing-diagnostics.js'
import { RepositoryInspectionLive } from './repository-inspection-live.js'
import { LedgerStore } from './store/ledger.js'
import { initializeLedger } from './store/ledger-initialization.js'
import { LedgerConfig, LedgerIngest, LedgerPortsLayer, LedgerQueries } from './store/ledger-repository.js'

export type WorkerServices =
  | AssistantSetup
  | ExportFiles
  | RepositoryInspection
  | CommandRunner
  | PricingDiagnostics
  | OperationalLog
  | Env
  | HttpFetch
  | FxRates
  | LedgerIngest
  | LedgerQueries
  | LedgerConfig
  | Sqlite.SqliteClient.SqliteClient
  | SqlClient.SqlClient
export type WorkerOverrides =
  | OperationalLog
  | Env
  | HttpFetch
  | FxRates
  | LedgerIngest
  | LedgerQueries
  | LedgerConfig
  | PricingDiagnostics
  | AssistantSetup
  | RepositoryInspection
  | CommandRunner
  | ExportFiles
export type WorkerSqlLayer = Layer.Layer<Sqlite.SqliteClient.SqliteClient | SqlClient.SqlClient>
export type WorkerRuntime = ManagedRuntime.ManagedRuntime<WorkerServices, never>

/** Worker root owns one SQL client and composes every ledger port over it. */
export function makeWorkerLive<Overrides extends WorkerOverrides = never>(
  dbPath: string,
  sink?: OperationalLogSink,
  overrides?: Layer.Layer<Overrides>,
  sqliteLayer: WorkerSqlLayer = Sqlite.SqliteClient.layer({ filename: dbPath }),
): Layer.Layer<WorkerServices> {
  const ledger = LedgerPortsLayer.pipe(Layer.provideMerge(sqliteLayer))
  const capabilities = Layer.mergeAll(ledger, AssistantSetupLive, ExportFilesLive, CommandRunner.layer)
  const dependencies = overrides ? Layer.mergeAll(capabilities, overrides) : capabilities
  const fxRates = FxRates.layer.pipe(Layer.provide(dependencies))
  const repositoryInspection = RepositoryInspectionLive.pipe(Layer.provide(dependencies))
  const liveFetch = HttpFetch.layerWithFetch((input, init) => globalThis.fetch(input, init))

  const live = Layer.mergeAll(
    sink ? operationalLogLoggerLayerWithSink(sink, 'worker') : OperationalLogLoggerLayer,
    OperationalLogTracerLayer('worker', sink),
    Env.layer,
    sink ? OperationalLog.layerWithSink(sink, 'worker') : OperationalLog.layer,
    liveFetch,
    PricingDiagnosticsLive,
    fxRates,
    repositoryInspection,
    dependencies,
  )
  return overrides ? Layer.mergeAll(live, overrides) : live
}

export function makeWorkerRuntime(
  dbPath: string,
  layer: Layer.Layer<WorkerServices> = makeWorkerLive(dbPath),
): WorkerRuntime {
  return ManagedRuntime.make(layer)
}

/**
 * The db-worker's one-owner factory. LedgerStore is a temporary synchronous
 * facade over the runtime's very same SqliteClient; it owns neither another
 * connection nor another runtime. The root runs the shared schema initializer
 * before constructing the facade, so callers cannot publish `ready` early.
 * On failed boot the runtime scope closes the real driver exactly once.
 */
export function openWorkerOwner<Overrides extends WorkerOverrides = never>(
  dbPath: string,
  sink?: OperationalLogSink,
  overrides?: Layer.Layer<Overrides>,
  options: {
    readonly sqliteLayer?: WorkerSqlLayer
    readonly makeRuntime?: typeof makeWorkerRuntime
  } = {},
): { ledger: LedgerStore; runtime: WorkerRuntime } {
  mkdirSync(dirname(dbPath), { recursive: true })
  const layer = makeWorkerLive(dbPath, sink, overrides, options.sqliteLayer)
  const runtime = (options.makeRuntime ?? makeWorkerRuntime)(dbPath, layer)
  try {
    runtime.runSync(initializeLedger)
    const ledger = new LedgerStore(dbPath, { runtime, initialize: false })
    return { ledger, runtime }
  } catch (error) {
    try {
      Effect.runSync(runtime.disposeEffect)
    } catch {
      // Preserve the initialization failure as the boot error.
    }
    throw error
  }
}
