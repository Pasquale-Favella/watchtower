import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'

import type { CoachHarnessRow } from '../../shared/schemas/agents.js'
import { safeLogOperationalEvent } from '../operational-log.js'
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

export interface HarnessSnapshotStoreDeps {
  detect: () => Promise<HarnessInfo[]>
  probe: (info: HarnessInfo) => Effect.Effect<ProbeResult, never>
  onChange: (rows: CoachHarnessRow[]) => void
  concurrency?: number
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

export function createHarnessSnapshotStore(deps: HarnessSnapshotStoreDeps): HarnessSnapshotStore {
  const instances = new Map<string, HarnessInstance>()
  const concurrency = deps.concurrency ?? 4
  let detected = false
  let lastPath: string | undefined
  let detectionPromise: Promise<void> | null = null
  let probeFiber: Fiber.Fiber<unknown, never> | null = null
  let generation = 0
  let disposed = false

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

  async function interruptProbes(): Promise<void> {
    const fiber = probeFiber
    probeFiber = null
    if (fiber) await Effect.runPromise(Fiber.interrupt(fiber))
  }

  function settle(info: HarnessInfo, result: ProbeResult, probeGeneration: number): void {
    safeLogOperationalEvent(result.status === 'error' ? 'error' : 'info', 'harness.probe', {
      kind: info.kind,
      status: result.status,
    })
    if (disposed || probeGeneration !== generation) return
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
  }

  function launchProbes(infos: HarnessInfo[], probeGeneration: number): void {
    const effects = infos.map(info =>
      deps.probe(info).pipe(Effect.tap(result => Effect.sync(() => settle(info, result, probeGeneration)))),
    )
    probeFiber = Effect.runFork(Effect.yieldNow.pipe(Effect.andThen(Effect.all(effects, { concurrency }))))
  }

  async function detectAndProbe(): Promise<void> {
    if (detectionPromise) return detectionPromise
    detectionPromise = (async () => {
      await interruptProbes()
      if (disposed) return
      const infos = await deps.detect()
      if (disposed) return
      generation += 1
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
      launchProbes(infos, generation)
    })().finally(() => {
      detectionPromise = null
    })
    return detectionPromise
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
      disposed = true
      generation += 1
      await interruptProbes()
      instances.clear()
    },
  }
}
