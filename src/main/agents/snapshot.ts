import * as Context from 'effect/Context'
import * as Deferred from 'effect/Deferred'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as FiberHandle from 'effect/FiberHandle'
import * as Layer from 'effect/Layer'
import * as Scope from 'effect/Scope'

import type { CoachHarnessRow } from '../../shared/schemas/agents.js'
import { emitOperationalRecord, type OperationalLogCounter, PROBE_OUTCOME_COUNTER } from '../operational-log.js'
import type { HarnessInfo } from './detect.js'
import { harnessSpecs } from './harnesses/index.js'
import { probeHarness, type ProbeResult, type ProbeStatus } from './probe.js'

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

export interface HarnessSnapshotStoreDeps {
  detect: () => Promise<HarnessInfo[]>
  probe: (info: HarnessInfo) => Effect.Effect<ProbeResult, never>
  onChange: (rows: CoachHarnessRow[]) => void
  concurrency?: number
  /** Optional counter sink (value-seam, not `R`-channel): defaults to the
   *  live singleton delegation below so forbidden `ipc.ts` keeps compiling
   *  with zero edits and prod files counters with no second sink. Tests
   *  inject a fake recording `incrementCounter` calls. */
  counters?: HarnessSnapshotCounters
}

export interface HarnessSnapshotStore {
  list: () => Promise<CoachHarnessRow[]>
  refresh: () => Promise<CoachHarnessRow[]>
  get: (instanceId: string) => Promise<HarnessInstance | undefined>
  /** Records the sign-in state a real run proved (finished turn / auth wall). */
  reportAuth: (instanceId: string, status: 'configured' | 'unauthenticated') => void
  start: () => void
  dispose: () => Promise<void>
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

/**
 * Minimal harness capability for `MainLive` (ADR 0032 §4.3): the never-fails
 * ACP handshake probe behind the existing `probeHarness` shape, exposed as a
 * `Context.Service` + `Layer` so the main runtime owns one copy and tests
 * substitute fakes via `layerWithProbe` (the `HttpFetch.layerWithFetch`
 * pattern). The live layer delegates to `probeHarness` with default deps;
 * `ipc.ts` keeps wiring its richer deps (clientVersion) at the store seam —
 * unifying that injection is a Config-DI follow-up, not this slice.
 */
export class HarnessProbe extends Context.Service<
  HarnessProbe,
  {
    readonly probe: (info: HarnessInfo) => Effect.Effect<ProbeResult, never>
  }
>()('watchtower/agents/HarnessProbe') {
  static readonly layer = Layer.succeed(HarnessProbe, HarnessProbe.of({ probe: info => probeHarness(info) }))

  static readonly layerWithProbe = (
    probeImpl: (info: HarnessInfo) => Effect.Effect<ProbeResult, never>,
  ): Layer.Layer<HarnessProbe> => Layer.succeed(HarnessProbe, HarnessProbe.of({ probe: probeImpl }))
}

/**
 * Live counter delegation for the probe-outcome slice (Wave 4, issue #148):
 * files `PROBE_OUTCOME_COUNTER` through the main-owned pino singleton via
 * `emitOperationalRecord` — the Effect-facing sink seam, so same sink, same
 * allowlist, same `main` context as the legacy `harness.probe` record, never a
 * second sink, never OTLP. The never-throw guard now lives in ONE place
 * (inside the seam's `emitSafely`) rather than being re-declared here, so the
 * forbidden `ipc.ts` call site (no `counters` dep) still files counters with
 * zero edits.
 */
const liveSnapshotCounters: HarnessSnapshotCounters = {
  incrementCounter: (name, amount = 1, fields = {}) =>
    emitOperationalRecord('info', name, { ...fields, count: amount }, 'main'),
}

export function createHarnessSnapshotStore(deps: HarnessSnapshotStoreDeps): HarnessSnapshotStore {
  const instances = new Map<string, HarnessInstance>()
  const concurrency = deps.concurrency ?? 4
  const counters = deps.counters ?? liveSnapshotCounters
  let detected = false
  let lastPath: string | undefined

  // Scope-owned probe lifecycle:
  // - `storeScope` owns the probe batch; `dispose()` closes it (LIFO), which
  //   interrupts the handle's fiber even on failure.
  // - `probeHandle` holds the single in-flight probe batch (`Effect.all` with
  //   bounded concurrency, `runFork` shape preserved). Installing a new batch
  //   interrupts the previous one, so stale settles cannot leak after a
  //   refresh.
  // - `flight` (a `Deferred` for the in-flight detection) coalesces concurrent
  //   `refresh()` calls into one `deps.detect()`, bridged to the Promise store
  //   API.
  const storeScope = Scope.makeUnsafe()
  const probeHandle = Effect.runSync(Scope.provide(storeScope)(FiberHandle.make<unknown, never>()))
  let flight: Deferred.Deferred<undefined, unknown> | null = null

  function isClosed(): boolean {
    return (storeScope.state._tag as string) === 'Closed'
  }

  function rows(): CoachHarnessRow[] {
    return [...instances.values()]
      .sort(
        (left, right) =>
          preferenceFor(left.info) - preferenceFor(right.info) ||
          left.info.displayName.localeCompare(right.info.displayName),
      )
      .map(toRow)
  }

  function publish(): void {
    try {
      deps.onChange(rows())
    } catch {
      /* UI notification must not stop probes */
    }
  }

  /** Returns an Effect rather than running itself so both records it files are
   * `yield*`ed in Effect context. The previous shape called the sink directly
   * and reached the counter through `Effect.runSync` from inside an
   * `Effect.sync(() => settle(...))` — a `run*` used only to make a log call,
   * which is the F10 composition-root violation this slice removes. */
  function settle(info: HarnessInfo, result: ProbeResult): Effect.Effect<void> {
    return Effect.gen(function* () {
      yield* emitOperationalRecord(result.status === 'error' ? 'error' : 'info', 'harness.probe', {
        kind: info.kind,
        status: result.status,
      })
      // `status` is allowlisted BY VALUE in `sanitizeOperationalRecord`
      // (`ALLOWED_ENUM_FIELDS.status`, transcribed from the
      // `ProbeResult['status']` union — no `pending`, since a settled probe is
      // never pending), so the counter breaks down by probe status instead of
      // losing the dimension. `kind` stays a free-form allowlisted string, and a
      // status the union cannot produce is still dropped, not filed.
      // `catchDefect` is the `try`/`catch` this replaced, in Effect terms: the
      // seam's declared channel is `never`, so a throwing counter sink can only
      // arrive as a defect, and it must still not stop `settle` from publishing
      // (pinned by `agents-snapshot.test.ts`).
      yield* counters
        .incrementCounter(PROBE_OUTCOME_COUNTER, 1, { kind: info.kind, status: result.status })
        .pipe(Effect.catchDefect(() => Effect.void))
      if (isClosed()) return
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
      publish()
    })
  }

  function launchProbes(infos: HarnessInfo[]): void {
    const effects = infos.map(info => deps.probe(info).pipe(Effect.tap(result => settle(info, result))))
    // `Effect.all` with bounded concurrency, forked in the background: the
    // handle interrupts it on the next launch (or `dispose()`). `deps.detect`
    // stays a Promise boundary; `deps.probe` stays the Effect seam.
    const fiber = Effect.runFork(Effect.yieldNow.pipe(Effect.andThen(Effect.all(effects, { concurrency }))))
    FiberHandle.setUnsafe(probeHandle, fiber)
  }

  async function detectAndProbe(): Promise<void> {
    if (flight) {
      await Effect.runPromise(Deferred.await(flight))
      return
    }
    const deferred = Deferred.makeUnsafe<undefined, unknown>()
    flight = deferred
    const resolveFlight = (): Promise<boolean> => Effect.runPromise(Deferred.succeed(deferred, undefined))
    try {
      // Interrupt the previous probe batch before re-detecting; the handle's
      // interruption owns staleness.
      await Effect.runPromise(FiberHandle.clear(probeHandle))
      if (isClosed()) {
        await resolveFlight()
        return
      }
      const infos = await deps.detect()
      if (isClosed()) {
        await resolveFlight()
        return
      }
      lastPath = process.env.PATH
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
      publish()
      launchProbes(infos)
      await resolveFlight()
    } catch (error) {
      await Effect.runPromise(Deferred.fail(deferred, error))
      throw error
    } finally {
      if (flight === deferred) flight = null
    }
  }

  async function list(): Promise<CoachHarnessRow[]> {
    if (!detected || lastPath !== process.env.PATH) await detectAndProbe()
    return rows()
  }

  return {
    list,
    async refresh() {
      await detectAndProbe()
      return rows()
    },
    async get(instanceId) {
      await list()
      return instances.get(instanceId)
    },
    reportAuth(instanceId, status) {
      const current = instances.get(instanceId)
      if (!current || current.status === 'error' || current.status === 'pending' || current.auth.status === status)
        return
      instances.set(instanceId, {
        ...current,
        status: status === 'configured' ? 'ready' : 'warning',
        auth: { ...current.auth, status },
        message: status === 'unauthenticated' ? `${current.info.displayName} is not signed in` : undefined,
      })
      publish()
    },
    start() {
      void list()
    },
    async dispose() {
      await Effect.runPromise(FiberHandle.clear(probeHandle))
      instances.clear()
      await Effect.runPromise(Scope.close(storeScope, Exit.void))
    },
  }
}
