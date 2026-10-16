import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'

import type { CoachHarnessRow } from '../shared/schemas/agents.js'
import { CommandRunner } from './agents/command-runner.js'
import { detectHarnesses, type HarnessInfo, which } from './agents/detect.js'
import { resolveBundledEntry } from './agents/harnesses/bundled.js'
import { LedgerMcpPool, ledgerMcpPoolLayer } from './agents/ledger-mcp/pool.js'
import { LedgerMcpSidecar, ledgerMcpSidecarLayer, type LedgerMcpSidecarOptions } from './agents/ledger-mcp/sidecar.js'
import type { ProbeResult } from './agents/probe.js'
import {
  CoachHarnessExecution,
  coachHarnessExecutionLayer,
  type HarnessRuntimeOptions,
  type HarnessSdk,
  loadHarnessSdk,
} from './agents/runtime.js'
import { HarnessProbe, HarnessSnapshot, harnessSnapshotLayer } from './agents/snapshot.js'
import { Env } from './env.js'
import {
  OperationalLog,
  OperationalLogLoggerLayer,
  OperationalLogMetricLayer,
  OperationalLogTracerLayer,
} from './operational-log.js'
import { HttpFetch } from './pipeline/fetch-utils.js'

/** Stable services available through the Electron main isolate's one runtime. */
export type MainServices =
  | HttpFetch
  | Env
  | OperationalLog
  | CommandRunner
  | HarnessProbe
  | HarnessSnapshot
  | LedgerMcpSidecar
  | LedgerMcpPool
  | CoachHarnessExecution
export type MainRuntime<Additional = never> = ManagedRuntime.ManagedRuntime<MainServices | Additional, never>

export interface MainRuntimeOptions {
  readonly clientVersion: string
  readonly appPath: string
  readonly onHarnessChange: (rows: CoachHarnessRow[]) => void
}

/** Focused overrides for composition tests. Production uses the live detector and probe. */
export interface MainRuntimeOverrides {
  readonly detect?: (pathEnv: string | undefined) => Promise<HarnessInfo[]>
  readonly probe?: (info: HarnessInfo, clientVersion: string) => Effect.Effect<ProbeResult>
  readonly readPath?: () => string | undefined
  readonly configProvider?: ConfigProvider.ConfigProvider
  readonly sidecar?: LedgerMcpSidecarOptions
  readonly coachSdk?: () => Promise<HarnessSdk>
  readonly coachRuntime?: HarnessRuntimeOptions
}

/** Shared main-process dependencies with no Electron or harness state. */
function mainLive(configProvider: ConfigProvider.ConfigProvider): Layer.Layer<HttpFetch | Env | OperationalLog> {
  const config = Layer.succeed(ConfigProvider.ConfigProvider, configProvider)
  return Layer.mergeAll(
    HttpFetch.layer,
    Env.layer.pipe(Layer.provide(config)),
    OperationalLog.layer,
    config,
    // The main isolate owns these references; child work inherits this context.
    OperationalLogLoggerLayer,
    OperationalLogMetricLayer,
    OperationalLogTracerLayer('main'),
  )
}

// Preserve Node's case-insensitive environment lookup on Windows, including Path/PATH.
const processConfigProvider = ConfigProvider.fromEnvRecord(process.env, {
  preserveEmptyStrings: true,
})

export const MainLive: Layer.Layer<HttpFetch | Env | OperationalLog> = mainLive(processConfigProvider)

/** Compose the main process's actual app-version-aware, scoped harness snapshot. */
export function makeMainLive(
  options: MainRuntimeOptions,
  overrides: MainRuntimeOverrides = {},
): Layer.Layer<MainServices> {
  const commandRunner = CommandRunner.layer
  const probeImpl = overrides.probe
  const probe = probeImpl
    ? HarnessProbe.layerWithProbe(info => probeImpl(info, options.clientVersion))
    : HarnessProbe.layerWithClientVersion(options.clientVersion)
  const probeAndRunner = probe.pipe(Layer.provideMerge(commandRunner))
  const mainServices = overrides.configProvider ? mainLive(overrides.configProvider) : MainLive
  const snapshot = harnessSnapshotLayer({
    detect:
      overrides.detect ??
      (pathEnv =>
        detectHarnesses({
          commandExists: command => which(command, pathEnv ?? ''),
          resolveBundled: spec => resolveBundledEntry(spec, options.appPath),
        })),
    onChange: options.onHarnessChange,
    ...(overrides.readPath ? { readPath: overrides.readPath } : {}),
  }).pipe(Layer.provideMerge(Layer.merge(mainServices, probeAndRunner)))

  const sidecar = ledgerMcpSidecarLayer(overrides.sidecar)
  const pool = ledgerMcpPoolLayer.pipe(Layer.provideMerge(sidecar))
  return Layer.mergeAll(
    snapshot,
    pool,
    coachHarnessExecutionLayer(overrides.coachRuntime, overrides.coachSdk ?? loadHarnessSdk),
  )
}

/** The only runtime constructor for this isolate. The root may add scoped
 * Electron services without importing Electron into the shared composition;
 * disposing the runtime closes both graphs together. */
export function makeMainRuntime(options: MainRuntimeOptions, overrides?: MainRuntimeOverrides): MainRuntime
export function makeMainRuntime<Additional>(
  options: MainRuntimeOptions,
  overrides: MainRuntimeOverrides,
  additional: Layer.Layer<Additional>,
): MainRuntime<Additional>
export function makeMainRuntime<Additional>(
  options: MainRuntimeOptions,
  overrides: MainRuntimeOverrides = {},
  additional?: Layer.Layer<Additional>,
): MainRuntime<Additional> | MainRuntime {
  const main = makeMainLive(options, overrides)
  return additional ? ManagedRuntime.make(Layer.merge(main, additional)) : ManagedRuntime.make(main)
}
