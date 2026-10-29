import * as Config from 'effect/Config'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as FiberHandle from 'effect/FiberHandle'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'

import type { CoachHarnessRow } from '../../shared/schemas/agents.js'
import { OperationalLog, type OperationalLogCounter, PROBE_OUTCOME_COUNTER } from '../operational-log.js'
import { CommandRunner } from './command-runner.js'
import type { HarnessInfo } from './detect.js'
import { harnessSpecs } from './harnesses/index.js'
import { probeHarnessWithCommandRunner, type ProbeResult, type ProbeStatus } from './probe.js'

export interface HarnessInstance {
  instanceId: string
  info: HarnessInfo
  status: ProbeStatus
  auth: ProbeResult['auth']
  version?: string
  message?: string
}

export interface HarnessSnapshotCounters {
  incrementCounter: (
    name: OperationalLogCounter,
    amount?: number,
    fields?: Record<string, unknown>,
  ) => Effect.Effect<void>
}

export interface HarnessSnapshotService {
  readonly current: () => Effect.Effect<CoachHarnessRow[]>
  readonly list: () => Effect.Effect<CoachHarnessRow[], unknown>
  readonly refresh: () => Effect.Effect<CoachHarnessRow[], unknown>
  readonly get: (instanceId: string) => Effect.Effect<HarnessInstance | undefined, unknown>
  readonly reportAuth: (instanceId: string, status: 'configured' | 'unauthenticated') => Effect.Effect<void>
  readonly start: () => Effect.Effect<void, unknown>
  readonly shutdown: () => Effect.Effect<void>
}

export interface HarnessSnapshotOptions {
  readonly detect: (pathEnv: string | undefined) => Promise<HarnessInfo[]>
  readonly onChange: (rows: CoachHarnessRow[]) => void
  readonly readPath?: () => string | undefined
  readonly concurrency?: number
  readonly counters?: HarnessSnapshotCounters
}

/** Owns the current harness inventory and its scoped probe batch. */
export class HarnessSnapshot extends Context.Service<HarnessSnapshot, HarnessSnapshotService>()(
  'watchtower/agents/HarnessSnapshot',
) {}

/** Probe capability used by the main runtime; its version is captured when the root is composed. */
export class HarnessProbe extends Context.Service<
  HarnessProbe,
  { readonly probe: (info: HarnessInfo) => Effect.Effect<ProbeResult> }
>()('watchtower/agents/HarnessProbe') {
  static readonly layerWithClientVersion = (clientVersion: string): Layer.Layer<HarnessProbe, never, CommandRunner> =>
    Layer.effect(
      HarnessProbe,
      Effect.map(CommandRunner, runner =>
        HarnessProbe.of({
          probe: info =>
            probeHarnessWithCommandRunner(info, clientVersion).pipe(Effect.provideService(CommandRunner, runner)),
        }),
      ),
    )

  static readonly layerWithProbe = (
    probeImpl: (info: HarnessInfo) => Effect.Effect<ProbeResult>,
  ): Layer.Layer<HarnessProbe> => Layer.succeed(HarnessProbe, HarnessProbe.of({ probe: probeImpl }))
}

function instanceIdFor(info: HarnessInfo): string {
  return info.instanceId ?? info.kind
}

function preferenceFor(info: HarnessInfo): number {
  return harnessSpecs.find(spec => spec.kind === info.kind)?.preference ?? 999
}

function toRow(instance: HarnessInstance): CoachHarnessRow {
  const spec = harnessSpecs.find(candidate => candidate.kind === instance.info.kind)
  const loginCommand = spec?.auth?.loginCommand
  return {
    instanceId: instance.instanceId,
    kind: instance.info.kind,
    displayName: instance.info.displayName,
    status: instance.status,
    auth: {
      ...instance.auth,
      ...(loginCommand ? { loginCommand: loginCommand.join(' ') } : {}),
    },
    ...(instance.version ? { version: instance.version } : {}),
    binaryPath: instance.info.bin,
    ...(instance.message ? { message: instance.message } : {}),
  }
}

function makeHarnessSnapshot(options: HarnessSnapshotOptions) {
  return Effect.gen(function* () {
    const probe = yield* HarnessProbe
    const operationalLog = yield* OperationalLog
    const configProvider = yield* ConfigProvider.ConfigProvider
    const probeHandle = yield* FiberHandle.make<unknown, never>()
    const detectionHandle = yield* FiberHandle.make<unknown, unknown>()
    const instances = new Map<string, HarnessInstance>()
    const concurrency = options.concurrency ?? 4
    const counters = options.counters ?? operationalLog
    const readPath = options.readPath
      ? Effect.sync(options.readPath)
      : Config.option(Config.String('PATH')).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, configProvider),
          Effect.map(Option.getOrUndefined),
          Effect.orElseSucceed(() => undefined),
        )
    let detected = false
    let stopped = false
    let lastPath: string | undefined
    let flight: Deferred.Deferred<CoachHarnessRow[], unknown> | null = null

    const rows = (): CoachHarnessRow[] =>
      [...instances.values()]
        .sort(
          (left, right) =>
            preferenceFor(left.info) - preferenceFor(right.info) ||
            left.info.displayName.localeCompare(right.info.displayName),
        )
        .map(toRow)

    const publish = Effect.fnUntraced(function* () {
      yield* Effect.try({ try: () => options.onChange(rows()), catch: () => undefined }).pipe(Effect.ignore)
    })

    const settle = (info: HarnessInfo, result: ProbeResult) =>
      Effect.gen(function* () {
        if (stopped) return
        const record = { event: 'harness.probe', context: 'main', kind: info.kind, status: result.status }
        yield* (result.status === 'error' ? Effect.logError('harness.probe') : Effect.logInfo('harness.probe')).pipe(
          Effect.annotateLogs(record),
        )
        yield* counters
          .incrementCounter(PROBE_OUTCOME_COUNTER, 1, { kind: info.kind, status: result.status })
          .pipe(Effect.catchDefect(() => Effect.void))

        const instanceId = instanceIdFor(info)
        const current = instances.get(instanceId)
        if (!current) return
        instances.set(instanceId, {
          ...current,
          status: result.status,
          auth: result.auth,
          version: result.version,
          message: result.message,
        })
        yield* publish()
      })

    const completeDetection = (deferred: Deferred.Deferred<CoachHarnessRow[], unknown>, pathEnv: string | undefined) =>
      Effect.gen(function* () {
        yield* FiberHandle.clear(probeHandle)
        const infos = yield* Effect.tryPromise({ try: () => options.detect(pathEnv), catch: error => error })
        if (stopped) return rows()
        lastPath = pathEnv
        detected = true
        instances.clear()
        for (const info of infos) {
          instances.set(instanceIdFor(info), {
            instanceId: instanceIdFor(info),
            info,
            status: 'pending',
            auth: { status: 'unknown' },
          })
        }
        yield* publish()
        if (stopped) return rows()
        const probes = infos.map(info => probe.probe(info).pipe(Effect.flatMap(result => settle(info, result))))
        yield* FiberHandle.run(probeHandle, Effect.all(probes, { concurrency }).pipe(Effect.asVoid))
        return rows()
      }).pipe(
        Effect.exit,
        Effect.flatMap(exit =>
          Deferred.done(deferred, exit).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (flight === deferred) flight = null
              }),
            ),
          ),
        ),
      )

    const requestDetection = (always: boolean): Effect.Effect<CoachHarnessRow[], unknown> =>
      Effect.gen(function* () {
        if (stopped) return rows()
        if (flight) return yield* Deferred.await(flight)
        const pathEnv = yield* readPath
        if (stopped) return rows()
        if (!always && detected && lastPath === pathEnv) return rows()

        const deferred = yield* Deferred.make<CoachHarnessRow[], unknown>()
        flight = deferred
        yield* FiberHandle.run(detectionHandle, completeDetection(deferred, pathEnv))
        return yield* Deferred.await(deferred)
      })

    return HarnessSnapshot.of({
      current: () => Effect.sync(rows),
      list: () => requestDetection(false),
      refresh: () => requestDetection(true),
      get: instanceId =>
        requestDetection(false).pipe(Effect.flatMap(() => Effect.sync(() => instances.get(instanceId)))),
      reportAuth: (instanceId, status) =>
        Effect.gen(function* () {
          const current = instances.get(instanceId)
          if (!current || current.status === 'error' || current.status === 'pending' || current.auth.status === status)
            return
          instances.set(instanceId, {
            ...current,
            status: status === 'configured' ? 'ready' : 'warning',
            auth: { ...current.auth, status },
            message: status === 'unauthenticated' ? `${current.info.displayName} is not signed in` : undefined,
          })
          yield* publish()
        }),
      start: () => requestDetection(false).pipe(Effect.asVoid),
      shutdown: () =>
        Effect.gen(function* () {
          stopped = true
          yield* FiberHandle.clear(detectionHandle)
          yield* FiberHandle.clear(probeHandle)
        }),
    })
  })
}

export const harnessSnapshotLayer = (
  options: HarnessSnapshotOptions,
): Layer.Layer<HarnessSnapshot, never, HarnessProbe | OperationalLog> =>
  Layer.effect(HarnessSnapshot, makeHarnessSnapshot(options))
