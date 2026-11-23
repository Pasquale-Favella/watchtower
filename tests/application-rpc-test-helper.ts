import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRpc from 'effect/reactivity/AtomRpc'
import * as RpcTest from 'effect/rpc/RpcTest'

import { analyticsHandlers, configHandlers, type RpcDataWorker } from '../src/platform/electron/main/rpc/handlers.js'
import { lifecycleHandlers, lifecycleLayer } from '../src/platform/electron/main/rpc/lifecycle.js'
import { nativeHandlers, type NativeRpcCapabilities } from '../src/platform/electron/main/rpc/native-handlers.js'
import { ApplicationClient } from '../src/renderer/shared/lib/application-rpc.js'
import { ApplicationRpcGroup } from '../src/shared/rpc/application.js'
import type { OverviewScope } from '../src/shared/schemas/overview.js'
import type { SkillsThresholds } from '../src/shared/schemas/skills.js'
import {
  unexpectedCheckoutInspectionHandlers,
  unexpectedShellHandlers,
  unexpectedTerminalHandlers,
  unexpectedWorkspaceHandlers,
  unexpectedWorkspacePanelHandlers,
} from './fixtures/unexpected-native-rpc.js'

export interface ApplicationRpcTestOverrides {
  readonly skills?: (scope: OverviewScope, thresholds?: SkillsThresholds) => Promise<unknown>
  readonly workerRequest?: RpcDataWorker['request']
}

/** Uses the generated application group and real RPC handlers for renderer tests. */
export function makeApplicationRpcTestClient(
  runtime: Atom.RegistryRuntimeFactory,
  overrides: ApplicationRpcTestOverrides = {},
) {
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
  }
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
    epoch: 'application-test',
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
    unexpectedWorkspacePanelHandlers,
    unexpectedCheckoutInspectionHandlers,
    unexpectedTerminalHandlers,
    analyticsHandlers({ request: workerRequest }),
    configHandlers({ request: workerRequest }, Effect.succeed(0)),
    nativeHandlers(nativeCapabilities),
    lifecycleHandlers.pipe(Layer.provide(lifecycle)),
  )
  const service = AtomRpc.Service<object>()('test/ApplicationRpc', {
    group: ApplicationRpcGroup,
    protocol: Layer.empty,
    runtime,
    makeEffect: RpcTest.makeClient(ApplicationRpcGroup, { flatten: true }).pipe(Effect.provide(handlers)),
  })
  return service as unknown as typeof ApplicationClient
}
