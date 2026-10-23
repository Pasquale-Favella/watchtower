import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as Schema from 'effect/Schema'
import { describe, expect, it, vi } from 'vitest'

import { nativeHandlers, type NativeRpcCapabilities } from '../src/main/rpc/native-handlers.js'
import { NativeRpcError, NativeRpcGroup } from '../src/shared/rpc/native.js'
import { skillsDismissalRequestSchema } from '../src/shared/schemas/skills.js'

const updateStatus = {
  revision: 0,
  currentVersion: '1.0.0',
  latestVersion: null,
  updateAvailable: false,
  tag: null,
  phase: 'idle' as const,
  installSupported: true,
  progress: null,
  message: null,
}

function capabilities(overrides: Partial<NativeRpcCapabilities> = {}): NativeRpcCapabilities {
  return {
    startScan: () => Effect.succeed({ ok: true }),
    isScanActive: () => Effect.succeed(false),
    getUpdateStatus: () => Effect.succeed(updateStatus),
    checkForUpdates: () => Effect.succeed(updateStatus),
    downloadUpdate: () => Effect.succeed(updateStatus),
    installUpdate: () => Effect.succeed(updateStatus),
    exportData: () => Effect.succeed({ ok: false, cancelled: true }),
    getLedgerMcpStatus: () => Effect.succeed({ startupMode: 'on-demand', running: false, url: null }),
    setLedgerMcpStartupMode: () => Effect.succeed({ startupMode: 'at-launch', running: true, url: 'http://localhost' }),
    getLedgerMcpConnection: () => Effect.succeed({ url: 'http://localhost', config: '{"token":"private"}' }),
    regenerateLedgerMcpToken: () => Effect.succeed({ startupMode: 'on-demand', running: false, url: null }),
    getAppVersion: () => Effect.succeed('1.0.0'),
    dismissSkill: () => Effect.succeed({ ok: true }),
    saveSkill: () => Effect.succeed({ ok: false, error: 'cancelled' }),
    getCoachHarnesses: () => Effect.succeed([]),
    refreshCoachHarnesses: () => Effect.succeed([]),
    inspectCoachHarness: () => Effect.succeed({ ok: false, error: 'unavailable' }),
    openCoachLoginTerminal: () => Effect.succeed({ ok: false, error: 'cancelled' }),
    ...overrides,
  }
}

describe('native application RPC', () => {
  it('dispatches native capabilities and preserves expected result unions', async () => {
    const startScan = vi.fn(() => Effect.succeed({ ok: true }))
    const exportData = vi.fn(() => Effect.succeed({ ok: false, cancelled: true } as const))
    const dismissSkill = vi.fn(() => Effect.succeed({ ok: true } as const))
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(NativeRpcGroup)
      const scan = yield* client['scan:start']({ provider: 'claude' })
      const exported = yield* client.export({ format: 'json' })
      const dismissed = yield* client['skills:dismiss']({ source: 'skill', name: 'candidate', reason: 'not reusable' })
      return { scan, exported, dismissed }
    }).pipe(Effect.scoped, Effect.provide(nativeHandlers(capabilities({ startScan, exportData, dismissSkill }))))

    await expect(Effect.runPromise(program)).resolves.toEqual({
      scan: { ok: true },
      exported: { ok: false, cancelled: true },
      dismissed: { ok: true },
    })
    expect(startScan).toHaveBeenCalledWith({ provider: 'claude' })
    expect(exportData).toHaveBeenCalledWith({ format: 'json' })
    expect(dismissSkill).toHaveBeenCalledWith({ source: 'skill', name: 'candidate', reason: 'not reusable' })
  })

  it('rejects malformed requests through the authoritative schema encoder', () => {
    expect(() =>
      Schema.encodeUnknownSync(skillsDismissalRequestSchema)({ source: 'other', name: 'x', reason: 'y' }),
    ).toThrow()
  })

  it('maps operational failures to a fixed error without exposing secrets', async () => {
    const secret = 'C:\\private\\ledger.db token=very-secret SELECT * FROM ledger'
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(NativeRpcGroup)
      return yield* Effect.exit(client['app:version']())
    }).pipe(
      Effect.scoped,
      Effect.provide(nativeHandlers(capabilities({ getAppVersion: () => Effect.fail(new Error(secret)) }))),
    )

    const result = await Effect.runPromise(program)
    expect(result._tag).toBe('Failure')
    if (result._tag === 'Failure') {
      const error = Cause.findError(result.cause)
      expect(error).toMatchObject({
        _tag: 'Success',
        success: new NativeRpcError({ code: 'operation-failed', message: 'Native operation failed' }),
      })
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(JSON.stringify(result)).not.toContain('private')
    }
  })
})
