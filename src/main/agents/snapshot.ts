import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as FiberHandle from 'effect/FiberHandle'
import * as Layer from 'effect/Layer'

import type { CoachHarnessRow } from '../../shared/schemas/agents.js'
import { type OperationalLogCounter, PROBE_OUTCOME_COUNTER } from '../operational-log.js'
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
  readonly list: () => Effect.Effect<CoachHarnessRow[], unknown>
  readonly refresh: () => Effect.Effect<CoachHarnessRow[], unknown>
  readonly get: (instanceId: string) => Effect.Effect<HarnessInstance | undefined, unknown>
  readonly reportAuth: (instanceId: string, status: 'configured' | 'unauthenticated') => Effect.Effect<void>
  readonly start: () => Effect.Effect<void, unknown>
}

export interface HarnessSnapshotOptions {
  readonly detect: () => Promise<HarnessInfo[]>
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

const liveSnapshotCounters: HarnessSnapshotCounters = {
  incrementCounter: (name, amount = 1, fields = {}) =>
    Effect.logInfo(name).pipe(Effect.annotateLogs({ event: name, context: 'main', ...fields, count: amount })),
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
    const probeHandle = yield* FiberHandle.make<unknown, never>()
    const detectionHandle = yield* FiberHandle.make<unknown, unknown>()
    const instances = new Map<string, HarnessInstance>()
    const concurrency = options.concurrency ?? 4
    const counters = options.counters ?? liveSnapshotCounters
    const readPath = options.readPath ?? (() => process.env.PATH)
    let detected = false
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

    const completeDetection = (deferred: Deferred.Deferred<CoachHarnessRow[], unknown>) =>
      Effect.gen(function* () {
        yield* FiberHandle.clear(probeHandle)
        const infos = yield* Effect.tryPromise({ try: options.detect, catch: error => error })
        lastPath = readPath()
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
        if (flight) return yield* Deferred.await(flight)
        if (!always && detected && lastPath === readPath()) return rows()

        const deferred = yield* Deferred.make<CoachHarnessRow[], unknown>()
        flight = deferred
        yield* FiberHandle.run(detectionHandle, completeDetection(deferred))
        return yield* Deferred.await(deferred)
      })

    return HarnessSnapshot.of({
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
    })
  })
}

export const harnessSnapshotLayer = (
  options: HarnessSnapshotOptions,
): Layer.Layer<HarnessSnapshot, never, HarnessProbe> => Layer.effect(HarnessSnapshot, makeHarnessSnapshot(options))
