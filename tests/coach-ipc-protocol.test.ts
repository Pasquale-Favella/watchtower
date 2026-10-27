import * as Cause from 'effect/Cause'
import * as Effect from 'effect/Effect'
import * as Exit from 'effect/Exit'
import * as RpcTest from 'effect/rpc/RpcTest'
import * as Stream from 'effect/Stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createApplicationAgents } from '../src/main/agents/ipc.js'
import { makeMainRuntime } from '../src/main/main-runtime.js'
import { coachHandlers } from '../src/main/rpc/coach-handlers.js'
import { CoachRpcError, CoachRpcGroup } from '../src/shared/rpc/coach.js'

afterEach(() => vi.useRealTimers())

describe('Coach RPC boundary', () => {
  it('starts harness detection after the preserved startup delay', async () => {
    vi.useFakeTimers()
    const detect = vi.fn(async () => [])
    const runtime = makeMainRuntime({ clientVersion: '4.2.1', appPath: '/app', onHarnessChange: () => {} }, { detect })
    const agents = createApplicationAgents({ runtime, ledgerMcpServer: () => Effect.succeed(null) })

    try {
      await vi.advanceTimersByTimeAsync(1499)
      expect(detect).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(detect).toHaveBeenCalledOnce()
    } finally {
      await agents.dispose()
      await Effect.runPromise(runtime.disposeEffect)
    }
  })

  it('interrupts delayed harness startup when the app-owned service is disposed', async () => {
    vi.useFakeTimers()
    const detect = vi.fn(async () => [])
    const runtime = makeMainRuntime({ clientVersion: '4.2.1', appPath: '/app', onHarnessChange: () => {} }, { detect })
    const agents = createApplicationAgents({ runtime, ledgerMcpServer: () => Effect.succeed(null) })

    try {
      await vi.advanceTimersByTimeAsync(1499)
      expect(detect).not.toHaveBeenCalled()
      await agents.dispose()
      await vi.advanceTimersByTimeAsync(1)
      expect(detect).not.toHaveBeenCalled()
    } finally {
      await Effect.runPromise(runtime.disposeEffect)
    }
  })

  it('validates malformed probes and reports safe typed failures for malformed runs', async () => {
    const runtime = makeMainRuntime(
      { clientVersion: '4.2.1', appPath: '/app', onHarnessChange: () => {} },
      { detect: async () => [] },
    )
    const agents = createApplicationAgents({ runtime, ledgerMcpServer: () => Effect.succeed(null) })
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoachRpcGroup)
      const runResult = yield* Effect.exit(Stream.runCollect(client['coach:run']({ harnessKind: '', prompt: 'hello' })))
      const cancelResult = yield* Effect.exit(client['coach:cancel']({ runId: 'foreign-run' }))
      yield* client['coach:reset']()
      return { runResult, cancelResult }
    }).pipe(Effect.scoped, Effect.provide(coachHandlers(agents.native)))

    try {
      const { runResult, cancelResult } = await runtime.runPromise(program)
      expect(Exit.isFailure(runResult)).toBe(true)
      if (Exit.isFailure(runResult)) {
        const error = Cause.findError(runResult.cause)
        expect(error).toMatchObject({
          _tag: 'Success',
          success: new CoachRpcError({ code: 'start-failed', message: 'Unable to start the Coach run.' }),
        })
      }
      expect(Exit.isFailure(cancelResult)).toBe(true)
      if (Exit.isFailure(cancelResult)) {
        const error = Cause.findError(cancelResult.cause)
        expect(error).toMatchObject({
          _tag: 'Success',
          success: new CoachRpcError({
            code: 'unauthorized',
            message: 'The Coach run is not owned by this connection.',
          }),
        })
      }
      await expect(runtime.runPromise(agents.native.inspect({ kind: '' }))).resolves.toEqual({
        ok: false,
        error: 'invalid coach inspect request',
      })
      await expect(runtime.runPromise(agents.native.openLoginTerminal({ instanceId: '' }))).resolves.toEqual({
        ok: false,
        error: 'invalid harness instance id',
      })
    } finally {
      await agents.dispose()
      await Effect.runPromise(runtime.disposeEffect)
    }
  })

  it('bounds a private harness startup error in the RPC stream failure', async () => {
    const privateError = new Error('private native details C:\\Users\\person\\config token=secret')
    const runtime = makeMainRuntime(
      { clientVersion: '4.2.1', appPath: '/app', onHarnessChange: () => {} },
      {
        detect: async () => {
          throw privateError
        },
      },
    )
    const agents = createApplicationAgents({ runtime, ledgerMcpServer: () => Effect.succeed(null) })
    const program = Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(CoachRpcGroup)
      return yield* Effect.exit(Stream.runCollect(client['coach:run']({ harnessKind: 'claude', prompt: 'hello' })))
    }).pipe(Effect.scoped, Effect.provide(coachHandlers(agents.native)))

    try {
      const result = await runtime.runPromise(program)
      expect(Exit.isFailure(result)).toBe(true)
      expect(JSON.stringify(result)).not.toContain('private native details')
      if (Exit.isFailure(result)) {
        const error = Cause.findError(result.cause)
        expect(error).toMatchObject({
          _tag: 'Success',
          success: new CoachRpcError({ code: 'start-failed', message: 'Unable to start the Coach run.' }),
        })
      }
    } finally {
      await agents.dispose()
      await Effect.runPromise(runtime.disposeEffect)
    }
  })
})
