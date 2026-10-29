import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Layer from 'effect/Layer'
import * as RpcServer from 'effect/rpc/RpcServer'
import * as Stream from 'effect/Stream'
import type { IpcMain } from 'electron'
import type { WebContents } from 'electron'

import type { NativeCoachRunnerCapabilities } from '../../src/main/agents/ipc.js'
import { coachHandlers } from '../../src/main/rpc/coach-handlers.js'
import { registerElectronRpc, type RpcWindowRole } from '../../src/main/rpc/electron.js'
import { type RpcMessagePort, serverProtocolLayer } from '../../src/shared/rpc/port-protocol.js'
import type { CoachEvent } from '../../src/shared/schemas/agents.js'
import { AppProbeRpcGroup, ProbeFailure, ProbeReadOnlyRpcGroup, ProbeRpcGroup } from './rpc-transport-contract.js'

interface CoachRunControl {
  readonly emit: (runId: string, event: CoachEvent) => void
  active: boolean
  cancelCalls: number
}

interface CoachHarnessDiagnostics {
  readonly starts: number
  readonly cancelCalls: Readonly<Record<string, number>>
  readonly activeRuns: Readonly<Record<string, boolean>>
}

interface CoachHarnessControl {
  readonly diagnostics: () => CoachHarnessDiagnostics
  readonly emit: (runId: string, event: CoachEvent) => boolean
  readonly burstNext: () => void
}

let nextCoachRun = 1
let burstNextCoachRun = false
const coachRuns = new Map<string, CoachRunControl>()

const coachCapabilities: NativeCoachRunnerCapabilities<never> = {
  list: Effect.succeed([]),
  refresh: Effect.succeed([]),
  inspect: () => Effect.succeed({ ok: false, error: 'Fixture inspection is unavailable.' }),
  start: (_request, emit, onRunId) =>
    Effect.sync(() => {
      const runId = `fixture-coach-${nextCoachRun++}`
      coachRuns.set(runId, { emit, active: true, cancelCalls: 0 })
      onRunId?.(runId)
      if (burstNextCoachRun) {
        burstNextCoachRun = false
        for (let index = 0; index < 160; index++) emit(runId, { kind: 'text', delta: 'x' })
      }
      return { ok: true, runId }
    }),
  cancel: runId =>
    Effect.sync(() => {
      const run = coachRuns.get(runId)
      if (run) {
        run.cancelCalls++
        run.active = false
      }
    }),
  reset: Effect.void,
}

const coachHarnessControl: CoachHarnessControl = {
  diagnostics: () => ({
    starts: nextCoachRun - 1,
    cancelCalls: Object.fromEntries([...coachRuns].map(([runId, run]) => [runId, run.cancelCalls])),
    activeRuns: Object.fromEntries([...coachRuns].map(([runId, run]) => [runId, run.active])),
  }),
  emit: (runId, event) => {
    const run = coachRuns.get(runId)
    if (!run) return false
    run.emit(runId, event)
    return true
  },
  burstNext: () => {
    burstNextCoachRun = true
  },
}

;(globalThis as typeof globalThis & { rpcTransportCoachHarness?: CoachHarnessControl }).rpcTransportCoachHarness =
  coachHarnessControl

export const installProbeRpc = (
  ipcMain: IpcMain,
  roles: ReadonlyMap<number, RpcWindowRole>,
  expectedUrls: ReadonlyMap<number, string>,
) => {
  let writes = 0
  let acceptedConnections = 0
  let activeConnections = 0
  let activeServerFibers = 0
  let teardowns = 0
  let peerPortCloses = 0
  let roleResolutionAttempts = 0
  let roleResolutionRejects = 0
  let lastLifecycle:
    | {
        readonly baseline: Readonly<Record<string, number>>
        readonly attached: Readonly<Record<string, number>>
        afterTeardown?: Readonly<Record<string, number>>
      }
    | undefined
  const lifecycleEvents = ['destroyed', 'render-process-gone', 'did-start-navigation'] as const
  const listenerCounts = (webContents: WebContents): Record<string, number> =>
    Object.fromEntries(lifecycleEvents.map(event => [event, webContents.listenerCount(event)]))

  const serverLayer = (role: RpcWindowRole, port: RpcMessagePort, webContents: WebContents) => {
    acceptedConnections += 1
    activeConnections += 1
    const attached = listenerCounts(webContents)
    const baseline = Object.fromEntries(lifecycleEvents.map(event => [event, (attached[event] ?? 0) - 1]))
    lastLifecycle = { baseline, attached }
    Effect.runSync(
      port.subscribeClose(() => {
        peerPortCloses += 1
      }),
    )
    const handlers = ProbeRpcGroup.toLayer({
      'probe:read': () => Effect.sync(() => ({ writes })),
      'probe:write': () =>
        Effect.sync(() => {
          writes += 1
        }).pipe(
          // The fixture models a committed command whose acknowledgement is lost.
          Effect.andThen(Effect.never),
        ),
      'probe:fail': () => Effect.fail(new ProbeFailure({ code: 'expected', message: 'typed fixture failure' })),
      'probe:finite-stream': () => Stream.fromIterable([1, 2, 3, 4]),
      'probe:infinite-stream': () => Stream.fromIterable(Array.from({ length: 1000 }, (_, index) => index)),
    })
    const appHandlers = Layer.merge(handlers, coachHandlers(coachCapabilities))
    const program =
      role === 'panel'
        ? RpcServer.make(ProbeReadOnlyRpcGroup, { disableTracing: true, disableFatalDefects: true }).pipe(
            Effect.provide(
              Layer.merge(
                ProbeReadOnlyRpcGroup.toLayer({
                  'probe:read': () => Effect.sync(() => ({ writes })),
                  'probe:finite-stream': () => Stream.fromIterable([1, 2, 3, 4]),
                }),
                serverProtocolLayer(port),
              ),
            ),
          )
        : RpcServer.make(AppProbeRpcGroup, { disableTracing: true, disableFatalDefects: true }).pipe(
            Effect.provide(Layer.merge(appHandlers, serverProtocolLayer(port))),
          )
    const fiber = Effect.runFork(program)
    activeServerFibers += 1
    fiber.addObserver(() => {
      activeServerFibers -= 1
    })
    let closed = false
    return () => {
      if (closed) return
      closed = true
      activeConnections -= 1
      teardowns += 1
      if (lastLifecycle?.attached === attached) {
        lastLifecycle.afterTeardown = listenerCounts(webContents)
      }
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }
  const dispose = registerElectronRpc({
    ipcMain,
    resolveRole: ({ webContents, frame, url }) => {
      roleResolutionAttempts += 1
      const role = roles.get(webContents.id)
      if (role && role !== 'beacon' && frame === webContents.mainFrame && expectedUrls.get(webContents.id) === url)
        return role
      roleResolutionRejects += 1
      return undefined
    },
    onConnection: (port, role, webContents) => serverLayer(role, port, webContents),
  })
  return {
    dispose,
    diagnostics: () => ({
      acceptedConnections,
      activeConnections,
      activeServerFibers,
      teardowns,
      peerPortCloses,
      roleResolutionAttempts,
      roleResolutionRejects,
      lastLifecycle,
    }),
  }
}
