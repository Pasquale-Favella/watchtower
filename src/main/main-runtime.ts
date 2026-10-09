import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'

import type { CoachHarnessRow } from '../shared/schemas/agents.js'
import { CommandRunner } from './agents/command-runner.js'
import { detectHarnesses, type HarnessInfo } from './agents/detect.js'
import { resolveBundledEntry } from './agents/harnesses/bundled.js'
import type { ProbeResult } from './agents/probe.js'
import { HarnessProbe, HarnessSnapshot, harnessSnapshotLayer } from './agents/snapshot.js'
import { Env } from './env.js'
import { OperationalLogLoggerLayer, OperationalLogTracerLayer } from './operational-log.js'
import { HttpFetch } from './pipeline/fetch-utils.js'

/** Stable services available through the Electron main isolate's one runtime. */
export type MainServices = HttpFetch | Env | CommandRunner | HarnessProbe | HarnessSnapshot
export type MainRuntime = ManagedRuntime.ManagedRuntime<MainServices, never>

export interface MainRuntimeOptions {
  readonly clientVersion: string
  readonly appPath: string
  readonly onHarnessChange: (rows: CoachHarnessRow[]) => void
}

/** Focused overrides for composition tests. Production uses the live detector and probe. */
export interface MainRuntimeOverrides {
  readonly detect?: () => Promise<HarnessInfo[]>
  readonly probe?: (info: HarnessInfo, clientVersion: string) => Effect.Effect<ProbeResult>
  readonly readPath?: () => string | undefined
}

/** Shared main-process dependencies with no Electron or harness state. */
export const MainLive: Layer.Layer<HttpFetch | Env> = Layer.mergeAll(
  HttpFetch.layer,
  Env.layer,
  // The main isolate owns these references; child work inherits this context.
  OperationalLogLoggerLayer,
  OperationalLogTracerLayer('main'),
)

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
  const snapshot = harnessSnapshotLayer({
    detect:
      overrides.detect ??
      (() => detectHarnesses({ resolveBundled: spec => resolveBundledEntry(spec, options.appPath) })),
    onChange: options.onHarnessChange,
    ...(overrides.readPath ? { readPath: overrides.readPath } : {}),
  }).pipe(Layer.provideMerge(probeAndRunner))

  return Layer.merge(MainLive, snapshot)
}

/** The only runtime constructor for this isolate; the root disposes its scope on quit. */
export function makeMainRuntime(options: MainRuntimeOptions, overrides: MainRuntimeOverrides = {}): MainRuntime {
  return ManagedRuntime.make(makeMainLive(options, overrides))
}
