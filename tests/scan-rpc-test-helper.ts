import * as Effect from 'effect/Effect'

import { NativeRpcError } from '../src/shared/rpc/native.js'
import type { ScanResult, ScanStatus } from '../src/shared/schemas/ipc.js'
import type { AnalyticalViews } from '../src/shared/schemas/views.js'
import { makeSettingsRpcTestClient } from './settings-rpc-test-helper.js'

export interface ScanRpcTestOverrides {
  status?: () => Effect.Effect<ScanStatus, unknown>
  analytics?: () => Effect.Effect<AnalyticalViews | null, unknown>
  active?: () => Effect.Effect<boolean, unknown>
  scan?: () => Effect.Effect<ScanResult, unknown>
}

/** Uses the real application AtomRpc group and RpcTest handler path for scan atoms. */
export function makeScanRpcTestClient(
  runtime: import('effect/reactivity/Atom').RegistryRuntimeFactory,
  overrides: ScanRpcTestOverrides = {},
) {
  return makeSettingsRpcTestClient(
    runtime,
    async operation => {
      if (operation === 'store:status')
        return Effect.runPromise(overrides.status?.() ?? Effect.succeed({ scanned: false }))
      if (operation === 'store:analytics') return Effect.runPromise(overrides.analytics?.() ?? Effect.succeed(null))
      throw new Error(`Unexpected scan worker request: ${operation}`)
    },
    {
      isScanActive: () => overrides.active?.() ?? Effect.succeed(false),
      startScan: () =>
        overrides.scan
          ? overrides
              .scan()
              .pipe(
                Effect.mapError(
                  () => new NativeRpcError({ code: 'operation-failed', message: 'Native operation failed' }),
                ),
              )
          : Effect.succeed({ ok: true }),
    },
  )
}
