import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Queue from 'effect/Queue'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRpc from 'effect/reactivity/AtomRpc'
import { RpcClientError } from 'effect/rpc/RpcClientError'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as Stream from 'effect/Stream'

import { analyticsHandlers, configHandlers, type RpcDataWorker } from '../src/platform/electron/main/rpc/handlers.js'
import { lifecycleHandlers, lifecycleLayer } from '../src/platform/electron/main/rpc/lifecycle.js'
import { nativeHandlers, type NativeRpcCapabilities } from '../src/platform/electron/main/rpc/native-handlers.js'
import { ApplicationClient } from '../src/renderer/shared/lib/application-rpc.js'
import { ApplicationRpcGroup } from '../src/shared/rpc/application.js'
import { CoachRpcError, CoachRpcGroup, type CoachRunFrame } from '../src/shared/rpc/coach.js'
import type {
  CoachHarnessRow,
  CoachInspectRequest,
  CoachInspectResult,
  CoachLoginTerminalResult,
} from '../src/shared/schemas/agents.js'
import type { OverviewScope } from '../src/shared/schemas/overview.js'
import type { SkillsThresholds } from '../src/shared/schemas/skills.js'
import { unexpectedShellHandlers, unexpectedWorkspaceHandlers } from './fixtures/unexpected-native-rpc.js'

export interface CoachRpcTestOverrides {
  readonly harnesses?: () => Effect.Effect<CoachHarnessRow[]>
  readonly refreshHarnesses?: () => Effect.Effect<CoachHarnessRow[]>
  readonly inspect?: (request: CoachInspectRequest) => Effect.Effect<CoachInspectResult>
  readonly openLogin?: (instanceId: string) => Effect.Effect<CoachLoginTerminalResult>
  readonly run?: (request: unknown) => Stream.Stream<CoachRunFrame, CoachRpcError | RpcClientError>
  readonly cancel?: (runId: string) => Effect.Effect<void, CoachRpcError>
  readonly reset?: () => Effect.Effect<void, CoachRpcError>
  readonly skills?: (scope: OverviewScope, thresholds?: SkillsThresholds) => Promise<unknown>
  readonly workerRequest?: RpcDataWorker['request']
}

/** Uses the generated application group and real RPC handlers for Coach renderer tests. */
export function makeCoachRpcTestClient(runtime: Atom.RegistryRuntimeFactory, overrides: CoachRpcTestOverrides = {}) {
  let nextRun = 0
  const activeRuns = new Map<string, Queue.Queue<CoachRunFrame, CoachRpcError>>()
  const stopRun = (runId: string): Effect.Effect<void> => {
    const queue = activeRuns.get(runId)
    return queue ? Queue.shutdown(queue) : Effect.void
  }
  const nativeCapabilities: NativeRpcCapabilities = {
    startScan: () => Effect.die(new Error('Unexpected scan request')),
    isScanActive: () => Effect.die(new Error('Unexpected scan request')),
    getUpdateStatus: () => Effect.die(new Error('Unexpected updater request')),
    checkForUpdates: () => Effect.die(new Error('Unexpected updater request')),
    downloadUpdate: () => Effect.die(new Error('Unexpected updater request')),
    installUpdate: () => Effect.die(new Error('Unexpected updater request')),
    exportData: () => Effect.die(new Error('Unexpected export request')),
    getLedgerMcpStatus: () => Effect.die(new Error('Unexpected MCP request')),
    setLedgerMcpStartupMode: () => Effect.die(new Error('Unexpected MCP request')),
    getLedgerMcpConnection: () => Effect.die(new Error('Unexpected MCP request')),
    regenerateLedgerMcpToken: () => Effect.die(new Error('Unexpected MCP request')),
    getAppVersion: () => Effect.die(new Error('Unexpected version request')),
    dismissSkill: () => Effect.die(new Error('Unexpected skill request')),
    saveSkill: () => Effect.die(new Error('Unexpected skill request')),
    getCoachHarnesses: overrides.harnesses ?? (() => Effect.succeed([])),
    refreshCoachHarnesses: overrides.refreshHarnesses ?? (() => Effect.succeed([])),
    inspectCoachHarness: overrides.inspect ?? (() => Effect.succeed({ ok: true })),
    openCoachLoginTerminal: overrides.openLogin ?? (() => Effect.succeed({ ok: true })),
  }
  const coachHandlers = CoachRpcGroup.toLayer({
    'coach:run': request => {
      const configured = overrides.run?.(request)
      // Allows the generated client to exercise a transport/protocol failure.
      if (configured) return configured as Stream.Stream<CoachRunFrame, CoachRpcError>
      return Stream.unwrap(
        Effect.gen(function* () {
          const runId = `run-${++nextRun}`
          const queue = yield* Queue.unbounded<CoachRunFrame, CoachRpcError>()
          activeRuns.set(runId, queue)
          return Stream.concat(Stream.make({ _tag: 'Started' as const, runId }), Stream.fromQueue(queue)).pipe(
            Stream.ensuring(Effect.sync(() => activeRuns.delete(runId))),
          )
        }),
      )
    },
    'coach:cancel': ({ runId }) => (overrides.cancel?.(runId) ?? Effect.void).pipe(Effect.andThen(stopRun(runId))),
    'coach:reset': () =>
      (overrides.reset?.() ?? Effect.void).pipe(
        Effect.andThen(Effect.forEach(Array.from(activeRuns.keys()), stopRun, { discard: true })),
      ),
  })
  const workerRequest: RpcDataWorker['request'] =
    overrides.workerRequest ??
    (async (operation: string, scope?: unknown, thresholds?: unknown) => {
      if (operation === 'skills:view')
        return overrides.skills?.(scope as OverviewScope, thresholds as SkillsThresholds | undefined) ?? null
      if (operation === 'settings:info') return { dataDir: '', dbSize: 0, dataDirSize: 0, cacheDir: '', cacheSize: 0 }
      if (operation === 'settings:clear') return { dataDir: '', dbSize: 0, dataDirSize: 0, cacheDir: '', cacheSize: 0 }
      if (operation === 'store:status') return { scanned: false }
      if (operation === 'currency:get') return { code: 'USD', symbol: '$', rate: 1 }
      if (operation === 'cadence:get') return 'daily'
      if (operation === 'currency:list') return []
      if (operation === 'pricing:refresh') return { ok: true }
      throw new Error(`Unexpected worker operation: ${operation}`)
    })
  const lifecycle = lifecycleLayer({
    epoch: 'coach-test',
    readSnapshot: {
      scanStatus: () => Effect.succeed({ scanned: false }),
      scanActivity: () => Effect.succeed({ scanning: false, progress: null, error: null }),
      currency: () => Effect.succeed({ code: 'USD', symbol: '$', rate: 1 }),
      updater: () => Effect.die(new Error('Unexpected updater snapshot')),
      harnesses: () => Effect.die(new Error('Unexpected harness snapshot')),
    },
  })
  const handlers = Layer.mergeAll(
    unexpectedShellHandlers,
    unexpectedWorkspaceHandlers,
    analyticsHandlers({ request: workerRequest }),
    configHandlers({ request: workerRequest }, Effect.succeed(0)),
    nativeHandlers(nativeCapabilities),
    coachHandlers,
    lifecycleHandlers.pipe(Layer.provide(lifecycle)),
  )
  const service = AtomRpc.Service<object>()('test/CoachApplicationRpc', {
    group: ApplicationRpcGroup,
    protocol: Layer.empty,
    runtime,
    makeEffect: RpcTest.makeClient(ApplicationRpcGroup, { flatten: true }).pipe(Effect.provide(handlers)),
  })
  return service as unknown as typeof ApplicationClient
}
