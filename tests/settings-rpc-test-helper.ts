import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Atom from 'effect/reactivity/Atom'
import * as AtomRpc from 'effect/reactivity/AtomRpc'
import * as RpcTest from 'effect/rpc/RpcTest'

import type { RpcDataWorker } from '../src/platform/electron/main/rpc/handlers.js'
import { analyticsHandlers, configHandlers } from '../src/platform/electron/main/rpc/handlers.js'
import { lifecycleHandlers, lifecycleLayer } from '../src/platform/electron/main/rpc/lifecycle.js'
import type { NativeRpcCapabilities } from '../src/platform/electron/main/rpc/native-handlers.js'
import { nativeHandlers } from '../src/platform/electron/main/rpc/native-handlers.js'
import { ApplicationClient } from '../src/renderer/shared/lib/application-rpc.js'
import { ShellRpcGroup } from '../src/shared/rpc/shell.js'
import { ApplicationRpcGroup } from '../src/shared/rpc/application.js'
import { unexpectedCoachHandlers, unexpectedShellRpcs } from './fixtures/unexpected-native-rpc.js'

const unexpected = () => Effect.die(new Error('Unexpected native operation in a settings RPC test'))

const defaultNativeCapabilities: NativeRpcCapabilities = {
  startScan: unexpected,
  isScanActive: unexpected,
  getUpdateStatus: unexpected,
  checkForUpdates: unexpected,
  downloadUpdate: unexpected,
  installUpdate: unexpected,
  exportData: unexpected,
  getLedgerMcpStatus: unexpected,
  setLedgerMcpStartupMode: unexpected,
  getLedgerMcpConnection: unexpected,
  regenerateLedgerMcpToken: unexpected,
  getAppVersion: unexpected,
  dismissSkill: unexpected,
  saveSkill: unexpected,
  getCoachHarnesses: unexpected,
  refreshCoachHarnesses: unexpected,
  inspectCoachHarness: unexpected,
  openCoachLoginTerminal: unexpected,
}

/** Uses the actual application group and its worker/main handlers in settings atom tests. */
export function makeSettingsRpcTestClient(
  runtime: Atom.RegistryRuntimeFactory,
  request: RpcDataWorker['request'],
  nativeOverrides: Partial<NativeRpcCapabilities> = {},
  ledgerGeneration: Effect.Effect<number> = Effect.succeed(0),
  shellOverrides: { readonly openSettings?: () => Effect.Effect<boolean> } = {},
) {
  const lifecycle = lifecycleLayer({
    epoch: 'settings-test',
    readSnapshot: {
      scanStatus: () => Effect.succeed(undefined),
      scanActivity: () => Effect.succeed(undefined),
      currency: () => Effect.succeed(undefined),
      updater: () => Effect.succeed(undefined),
      harnesses: () => Effect.succeed(undefined),
    },
  })
  const handlers = Layer.mergeAll(
    unexpectedCoachHandlers,
    ShellRpcGroup.toLayer({ ...unexpectedShellRpcs, 'shell:open-settings': shellOverrides.openSettings ?? unexpected }),
    analyticsHandlers({ request }),
    configHandlers(
      { request },
      Effect.sync(() => 0),
      ledgerGeneration,
    ),
    nativeHandlers({ ...defaultNativeCapabilities, ...nativeOverrides }),
    lifecycleHandlers.pipe(Layer.provide(lifecycle)),
  )
  const client = AtomRpc.Service<object>()('test/SettingsApplicationRpc', {
    group: ApplicationRpcGroup,
    protocol: Layer.empty,
    runtime,
    makeEffect: RpcTest.makeClient(ApplicationRpcGroup, { flatten: true }).pipe(Effect.provide(handlers)),
  })
  // The runtime type is nominal per service id; this test client uses the exact application group and handlers.
  return client as unknown as typeof ApplicationClient
}
